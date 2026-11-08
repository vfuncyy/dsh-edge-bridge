// Contract checks that no behavioural test can catch: the shapes that have to
// line up across three files (plugin → extension → docs) but are only visible as
// text. Run it after touching tools.js, background.js, page.js or the README.
//
// Usage: ELECTRON_RUN_AS_NODE=1 "<DSH exe>" edge-bridge/tools/test-contract.mjs
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`);
}

const toolsSource = read('plugin', 'lib', 'tools.js');
const bridgeSource = read('plugin', 'lib', 'bridge.js');
const backgroundSource = read('extension', 'background.js');
const pageSource = read('extension', 'page.js');
const readme = read('README.md');
const pkg = JSON.parse(read('plugin', 'package.json'));
const manifest = JSON.parse(read('extension', 'manifest.json'));

// ---- 1. Tool inventory: one source of truth, reported the same way everywhere.
const toolNames = [...toolsSource.matchAll(/name:\s*'(edge_[a-z]+)'/g)].map((match) => match[1]);
check('tools.js defines seven browser tools', toolNames.length === 7, toolNames.join(', '));
check('every browser tool name is unique', new Set(toolNames).size === toolNames.length, toolNames.join(', '));
for (const expected of ['edge_status', 'edge_tabs', 'edge_read', 'edge_inspect', 'edge_eval', 'edge_act', 'edge_screenshot']) {
  check(`tools.js registers ${expected}`, toolNames.includes(expected), toolNames.join(', '));
}

const controlSource = read('plugin', 'lib', 'controller.js');
check('controller.js still exposes the edge_bridge control tool', /name:\s*'edge_bridge'/.test(controlSource));

// ---- 2. Capability list: the plugin's HOST_CAPS must equal the extension's HANDLERS.
const hostCaps = [...(bridgeSource.match(/const HOST_CAPS = \[([\s\S]*?)\];/)?.[1] ?? '').matchAll(/'([a-z.]+)'/g)].map((m) => m[1]);
const handlersBlock = backgroundSource.slice(backgroundSource.indexOf('const HANDLERS = {'));
const handlerNames = [...handlersBlock.slice(0, 40000).matchAll(/^\s{2}(?:async\s+)?'([a-z.]+)'\(params\)/gm)].map((m) => m[1]);
check('HOST_CAPS is not empty', hostCaps.length > 0, hostCaps.join(', '));
check('HANDLERS is not empty', handlerNames.length > 0, handlerNames.join(', '));
check('HOST_CAPS and HANDLERS name the same methods', hostCaps.slice().sort().join(',') === handlerNames.slice().sort().join(','), `plugin: ${hostCaps.join(', ')}\n      extension: ${handlerNames.join(', ')}`);

// ---- 3. effect_state plumbing: every hop has to carry the field, or the model
//         sees a bare "clicked" and cannot tell a commit from a guess.
check('actPage computes an effect for a click', /effect:\s*effectOf\(/.test(pageSource));
const effectBranches = (pageSource.match(/effect:\s*effectOf\(/g) ?? []).length;
check('actPage reports an effect on every action branch', effectBranches >= 5, `found ${effectBranches}`);
check('a failed expectation returns effect none', /state:\s*'none'/.test(pageSource));
check('page.act handler returns the effect to the plugin', /effect:\s*result\.effect/.test(backgroundSource));
check("page.act handler surfaces effect_state on a failed action", /effect_state: \$\{effect\.state\}/.test(backgroundSource));
check('edge_act renders an effect_state line', /effect_state: \$\{effect\.state\}/.test(toolsSource));
check('edge_act warns instead of retrying after a timeout', /Do NOT repeat it blindly/.test(toolsSource));

// ---- 4. ref plumbing.
check('inspectPage stamps a data-dsh-ref', /data-dsh-ref/.test(pageSource) && /setAttribute\('data-dsh-ref'/.test(pageSource));
check('actPage resolves a ref before a selector', /ref\) \{\s*\n?\s*[\s\S]{0,400}?selector\)/.test(pageSource) || /byRef\(ref\)/.test(pageSource));
check('edge_act accepts a ref parameter', /ref:\s*\{[^}]*Element ref from edge_inspect/.test(toolsSource));
check('edge_inspect renders the ref before the selector', /element\.ref \? `\$\{element\.ref\} \$\{element\.sel\}`/.test(toolsSource));

// ---- 5. Version and documented counts.
check('plugin and extension versions match', pkg.version === manifest.version, `${pkg.version} vs ${manifest.version}`);
check('bridge.js reads the version instead of hardcoding it', /readServerVersion\(\)/.test(bridgeSource) && !/version:\s*'\d+\.\d+\.\d+'/.test(bridgeSource));
check('the greeting advertises the package version', /server:\s*\{\s*name:\s*'dsh-edge-bridge',\s*version:\s*SERVER_VERSION\s*\}/.test(bridgeSource.replace(/\s+/g, ' ').replace(/, version/gi, ', version')) || /version:\s*SERVER_VERSION/.test(bridgeSource));
check('README names seven browser tools', /七个浏览器工具/.test(readme));
check('README does not still say six browser tools', !/六个浏览器工具/.test(readme));
check('README does not still say "6 个 edge_"', !/6 个 edge_/.test(readme));
// ---- 6. The skill document lives outside the repository (installed skills are
//         user-level), so it is checked only when it happens to be present.
const skillPath = join(process.env.DSH_HOME || 'E:/.dsh', 'skills', 'dsh-browser-extension-bridge', 'SKILL.md');
if (existsSync(skillPath)) {
  const skill = readFileSync(skillPath, 'utf8');
  check('SKILL.md names seven browser tools', /七个浏览器工具/.test(skill));
  // Mentions inside a grep pattern or a "don't hardcode counts" pitfall line are
  // instructions about the old wording, not claims that still use it.
  const staleSkillLines = skill
    .split(/\r?\n/)
    .filter((line) => /六个浏览器工具/.test(line))
    .filter((line) => !/grep|硬编码|写死/.test(line));
  check('SKILL.md makes no stale six-tool claim', staleSkillLines.length === 0, staleSkillLines.join('\n      '));
  check('SKILL.md documents ref, expect and effect_state', /ref/.test(skill) && /expect/.test(skill) && /effect_state/.test(skill));
  check('SKILL.md mentions capability negotiation', /能力位|caps/.test(skill));
} else {
  console.log(`skip  SKILL.md not found at ${skillPath}`);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
