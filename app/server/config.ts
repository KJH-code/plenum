// 설정 파일: Windows %APPDATA%\plenum\config.json, 그 밖 ~/.config/plenum (XDG_CONFIG_HOME), 테스트는 PLENUM_CONFIG_DIR.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
  source: 'local' | 'github';
  url?: string;
}

export interface Config {
  version: 1;
  kitRepoPath: string | null;
  cloneDir: string;
  editorCommand: string;
  projects: ProjectEntry[];
}

export function configDir(env = process.env, platform = process.platform): string {
  if (env.PLENUM_CONFIG_DIR) return path.resolve(env.PLENUM_CONFIG_DIR);
  if (platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'plenum');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'plenum');
}

export function defaultConfig(): Config {
  return {
    version: 1,
    kitRepoPath: null,
    cloneDir: path.join(os.homedir(), 'Documents', 'GitHub'),
    editorCommand: 'code',
    projects: [],
  };
}

export function loadConfig(dir = configDir()): Config {
  const file = path.join(dir, 'config.json');
  if (!fs.existsSync(file)) return defaultConfig();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = defaultConfig();
  return {
    version: 1,
    kitRepoPath: typeof raw.kitRepoPath === 'string' ? raw.kitRepoPath : null,
    cloneDir: typeof raw.cloneDir === 'string' && raw.cloneDir ? raw.cloneDir : base.cloneDir,
    editorCommand: typeof raw.editorCommand === 'string' && raw.editorCommand ? raw.editorCommand : base.editorCommand,
    projects: Array.isArray(raw.projects) ? raw.projects.filter((p: any) => p && typeof p.id === 'string' && typeof p.path === 'string') : [],
  };
}

// 임시 파일에 쓴 뒤 rename. 쓰다가 죽어도 이전 config.json이 남는다.
export function saveConfig(cfg: Config, dir = configDir()): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  const tmp = path.join(dir, `config.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
