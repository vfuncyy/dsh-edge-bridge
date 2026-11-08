// List every unpacked extension Edge knows about, so a stale duplicate copy of
// the bridge is visible instead of guessed at. Read-only: it only parses the
// profile Preferences file.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const roots = [
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data'),
].filter(Boolean);

for (const root of roots) {
  if (!existsSync(root)) continue;
  const profiles = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name === 'Default' || name.startsWith('Profile'));
  for (const profile of profiles) {
    const file = join(root, profile, 'Preferences');
    if (!existsSync(file)) continue;
    let prefs;
    try {
      prefs = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const settings = prefs?.extensions?.settings ?? {};
    for (const [id, value] of Object.entries(settings)) {
      const path = String(value?.path ?? '');
      const name = String(value?.manifest?.name ?? '');
      if (!/edge-bridge|edge bridge/i.test(path) && !/edge bridge/i.test(name)) continue;
      console.log(
        [
          `profile=${profile}`,
          `id=${id}`,
          `name=${JSON.stringify(name)}`,
          `version=${value?.manifest?.version ?? '?'}`,
          `state=${value?.state ?? '?'}`,
          `location=${value?.location ?? '?'}`,
          `path=${path}`,
        ].join('\n  '),
      );
      console.log('');
    }
  }
}
