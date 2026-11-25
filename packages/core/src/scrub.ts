// What never leaves this machine in text F publishes: the published page (server.ts artifact()) and what F posts to a host
// (F escalate's comment). A local path, and the OS user name in a gate reason's "set by <name> (local, unverified)".
const STOP = String.raw`\n\r"'\x60<>|(){}\[\];,&*?`;
const BODY = String.raw`(?:(?:(?!\s+https?:\/\/)[^${STOP}])*[^\s${STOP}])?`;
const ROOTS = 'Users|home|Volumes|srv|private|var|tmp|opt|mnt|media|root|usr|etc|Library|Applications|nix|workspaces?';
export const LOCAL_PATH = new RegExp([
  String.raw`\b(?:[\w.+-]+:\/\/(?:\/|file\/)|(?:vscode|cursor|windsurf)[\w.+-]*:\/\/)[^\s"'\x60<>]*`, // file:///…, vscode://file/…, vscode-remote://…
  String.raw`(?<![\w\\])\\\\[\w.$-]+\\${BODY}`, // \\server\share…, \\wsl.localhost\…
  String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/]${BODY}`, // C:\…, C:/…, D:\
  String.raw`(?<!\w)~[\\/]${BODY}`,
  String.raw`(?<!\w)\/(?:${ROOTS})(?![\w.-])${BODY}`, // also after ':' or '=' (PATH=/a:/Users/…, cwd:/Users/…)
  String.raw`(?<![\w.\/~-])\/(?!api\/)[^\s\/${STOP}]+\/${BODY}`, // any other path with 2+ segments (cwd:/data/x); "/factory approve" and /api/… routes stay
].join('|'), 'g');

// A local (unverified) author is the OS user, which may be DOMAIN\user: never published. Its setBy/by becomes LOCAL_USER, and so
// does the name in "set by <name> (local, unverified)" (gate.ts reasons); residue() refuses any that is left.
export const LOCAL_USER = 'a local user';
// The name part is what LOCAL_BY allows (1-100 characters, no control character), quotes included.
export const LOCAL_BY_TEXT = /\bset by [^\x00-\x1f\x7f]{1,100}? \(local, unverified\)/g;
export const scrubText = (s: string) => s.replace(LOCAL_BY_TEXT, `set by ${LOCAL_USER} (local, unverified)`).replace(LOCAL_PATH, '[local path]');
