// Moves top-level declarations from one ES module into another, unchanged (docs/plans/split.md, rule 5: regenerate, don't rebase).
// Usage: node scripts/split/move.ts <from.mjs> <to.ts> <name,name,...>
// - takes each named top-level statement with its leading comments, verbatim, and appends it to <to> (created with // @ts-nocheck);
// - gives <to> the imports its moved code needs: node built-ins and other modules as <from> imported them, re-pathed, and every
//   name still declared in <from> from <from> itself (an import cycle: fine for functions, so top-level code must not use them);
// - gives <from> an import of the moved names it still uses, and re-exports the ones it exported, so its importers don't change.
// Refuses: statements that use import.meta (their meaning depends on the file), and `let`s assigned on the other side of the move.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const [from, to, list] = process.argv.slice(2);
if (!from || !to || !list) throw new Error('usage: move.ts <from> <to> <name,name,...>');
const want = new Set(list.split(',').map((s) => s.trim()).filter(Boolean));
const src = fs.readFileSync(from, 'utf8');
const sf = ts.createSourceFile(from, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

const declared = (st: ts.Statement): string[] => {
  if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) return [st.name.text];
  if (ts.isVariableStatement(st)) return st.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []));
  return [];
};
const exported = (st: ts.Statement) => !!ts.getModifiers(st as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const isLet = (st: ts.Statement) => ts.isVariableStatement(st) && !(st.declarationList.flags & ts.NodeFlags.Const);

// What <from> imports: local binding -> { spec, imported name or '*' / 'default' }
const imports = new Map<string, { spec: string; name: string }>();
for (const st of sf.statements) if (ts.isImportDeclaration(st) && st.importClause) {
  const spec = (st.moduleSpecifier as ts.StringLiteral).text, c = st.importClause;
  if (c.name) imports.set(c.name.text, { spec, name: 'default' });
  const nb = c.namedBindings;
  if (nb && ts.isNamespaceImport(nb)) imports.set(nb.name.text, { spec, name: '*' });
  if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) imports.set(e.name.text, { spec, name: (e.propertyName || e.name).text });
}

// A statement's end, including a comment that trails it on the same line.
const endOf = (st: ts.Statement) => { const m = /^[ \t]*\/\/[^\n]*/.exec(src.slice(st.getEnd())); return st.getEnd() + (m ? m[0].length : 0); };
// A statement's start: its leading comments, but not a comment trailing the previous statement on its line.
const prevOf = new Map(sf.statements.map((st, i) => [st, sf.statements[i - 1]] as const));
const startOf = (st: ts.Statement) => { const p = prevOf.get(st); return p ? Math.max(st.getFullStart(), endOf(p)) : st.getFullStart(); };
const moving: ts.Statement[] = [], staying: ts.Statement[] = [];
const topNames = new Set<string>();
for (const st of sf.statements) {
  const names = declared(st);
  names.forEach((n) => topNames.add(n));
  if (names.some((n) => want.has(n))) {
    const stray = names.filter((n) => !want.has(n));
    if (stray.length) throw new Error(`${names.join(', ')} share one statement; also list ${stray.join(', ')}`);
    moving.push(st);
  } else staying.push(st);
}
const found = new Set(moving.flatMap(declared));
const missing = [...want].filter((n) => !found.has(n));
if (missing.length) throw new Error(`not top-level declarations in ${from}: ${missing.join(', ')}`);

// Identifiers a set of statements reads or writes (over-approximate: any Identifier that isn't a property name).
function uses(sts: ts.Statement[], guard = false) {
  const read = new Set<string>(), written = new Set<string>();
  const visit = (n: ts.Node) => {
    if (guard && ts.isMetaProperty(n)) throw new Error(`refusing to move code that uses import.meta (line ${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1})`);
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isProp = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isMethodDeclaration(p) && p.name === n) || (ts.isPropertySignature?.(p) && p.name === n);
      if (!isProp) read.add(n.text);
      if (ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) written.add(n.text);
      if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(p.operator)) written.add(n.text);
    }
    if (ts.isShorthandPropertyAssignment(n)) read.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  sts.forEach(visit);
  return { read, written };
}
const movedUse = uses(moving, true), stayUse = uses(staying.filter((s) => !ts.isImportDeclaration(s)));
const movedLets = new Set(moving.filter(isLet).flatMap(declared)), stayLets = new Set(staying.filter(isLet).flatMap(declared));
const bad = [...[...movedLets].filter((n) => stayUse.written.has(n)), ...[...stayLets].filter((n) => movedUse.written.has(n))];
if (bad.length) throw new Error(`a let would be assigned across the move: ${bad.join(', ')}`);

const rel = (fromFile: string, spec: string) => { // re-path a relative specifier written in <from> for <to>
  if (!spec.startsWith('.')) return spec;
  let r = path.relative(path.dirname(fromFile), path.resolve(path.dirname(from), spec)).split(path.sep).join('/');
  return r.startsWith('.') ? r : './' + r;
};
const relTo = (target: string) => { let r = path.relative(path.dirname(to), target).split(path.sep).join('/'); return r.startsWith('.') ? r : './' + r; };

// Imports for <to>
const needFromFrom = new Set<string>(); // names <to> imports from <from>: they must be exported there
const bySpec = new Map<string, { def?: string; ns?: string; named: string[] }>();
const add = (spec: string, local: string, name: string) => {
  const e = bySpec.get(spec) || { named: [] };
  if (name === 'default') e.def = local; else if (name === '*') e.ns = local; else e.named.push(name === local ? local : `${name} as ${local}`);
  bySpec.set(spec, e);
};
for (const n of [...movedUse.read].sort()) {
  if (found.has(n)) continue;
  const imp = imports.get(n);
  if (imp) add(rel(to, imp.spec), n, imp.name);
  else if (topNames.has(n)) { add(relTo(from), n, n); needFromFrom.add(n); }
}
const importLines = [...bySpec].map(([spec, e]) => {
  const parts = [e.def, e.ns && `* as ${e.ns}`, e.named.length && `{ ${[...new Set(e.named)].join(', ')} }`].filter(Boolean);
  return `import ${parts.join(', ')} from '${spec}';`;
});

// <to>: existing content (minus its import block, which is rebuilt as a union) + moved statements, each exported.
let head = '// @ts-nocheck\n', body = '', prevImports: string[] = [];
if (fs.existsSync(to)) {
  const old = fs.readFileSync(to, 'utf8').replace(/^\/\/ @ts-nocheck\n/, '');
  const lines = old.split('\n'), i = lines.findIndex((l) => !/^import .* from '.*';$/.test(l));
  prevImports = lines.slice(0, i); body = lines.slice(i).join('\n').replace(/^\n+/, '');
}
const mergedImports = mergeImports([...prevImports, ...importLines]);
const chunk = moving.map((st) => {
  const text = src.slice(startOf(st), endOf(st)).replace(/^\n+/, '');
  return exported(st) ? text : text.replace(/^((?:\s*\/\/.*\n|\s*\/\*[^]*?\*\/\n)*)(\s*)/, '$1$2export ');
}).join('\n');
fs.mkdirSync(path.dirname(to), { recursive: true });
fs.writeFileSync(to, head + mergedImports.join('\n') + '\n\n' + (body ? body.replace(/\n*$/, '\n') : '') + chunk + '\n');

// <from>: drop the moved statements, import back what it still uses, re-export what it exported.
const back = [...found].filter((n) => stayUse.read.has(n)).sort();
const reexp = moving.filter(exported).flatMap(declared).sort();
let out = '', pos = 0;
const toExport = staying.filter((st) => !exported(st) && declared(st).some((n) => needFromFrom.has(n)));
const cuts = [...moving.map((st) => ({ st, cut: true })), ...toExport.map((st) => ({ st, cut: false }))].sort((x, y) => x.st.getStart() - y.st.getStart());
for (const { st, cut } of cuts) {
  if (cut) { out += src.slice(pos, startOf(st)); pos = endOf(st); }
  else { out += src.slice(pos, st.getStart()) + 'export '; pos = st.getStart(); }
}
out += src.slice(pos);
const lastImport = [...sf.statements].filter(ts.isImportDeclaration).pop();
const names = [...new Set([...back, ...reexp])].sort();
const toSpec = path.relative(path.dirname(from), to).split(path.sep).join('/').replace(/^(?!\.)/, './');
const line = `import { ${names.join(', ')} } from '${toSpec}';` +
  (reexp.length ? `\nexport { ${reexp.join(', ')} };` : '');
if (names.length) {
  const at = out.indexOf(src.slice(lastImport!.getStart(), lastImport!.getEnd())) + (lastImport!.getEnd() - lastImport!.getStart());
  out = out.slice(0, at) + '\n' + line + out.slice(at);
}
fs.writeFileSync(from, mergeFromImports(out));

// Files moved earlier (siblings of <to>) that imported these names from <from> now import them from <to>.
for (const f of fs.readdirSync(path.dirname(to)).filter((f) => f.endsWith('.ts')).map((f) => path.join(path.dirname(to), f))) {
  if (path.resolve(f) === path.resolve(to)) continue;
  const fromSpec = (() => { const r = path.relative(path.dirname(f), from).split(path.sep).join('/'); return r.startsWith('.') ? r : './' + r; })();
  const toSpec2 = (() => { const r = path.relative(path.dirname(f), to).split(path.sep).join('/'); return r.startsWith('.') ? r : './' + r; })();
  let t = fs.readFileSync(f, 'utf8');
  const re = new RegExp(`^import \\{ ([^}]*) \\} from '${fromSpec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}';$`, 'm'), m = re.exec(t);
  if (!m) continue;
  const names2 = m[1].split(', '), go = names2.filter((n) => found.has(n)), stay = names2.filter((n) => !found.has(n));
  if (!go.length) continue;
  t = t.replace(m[0], [stay.length ? `import { ${stay.join(', ')} } from '${fromSpec}';` : '', `import { ${go.join(', ')} } from '${toSpec2}';`].filter(Boolean).join('\n'));
  fs.writeFileSync(f, mergeFromImports(t));
}
console.log(JSON.stringify({ moved: [...found], to, importsInTo: importLines.length, importedBack: back, reexported: reexp }));

// Union of import lines per specifier (so repeated moves into one file stay tidy).
function mergeImports(lines: string[]) {
  const m = new Map<string, Set<string>>(), extra: string[] = [];
  for (const l of lines) {
    const x = /^import \{ (.*) \} from '(.*)';$/.exec(l);
    if (!x) { if (!extra.includes(l)) extra.push(l); continue; }
    const s = m.get(x[2]) || new Set(); x[1].split(', ').forEach((n) => s.add(n)); m.set(x[2], s);
  }
  return [...extra, ...[...m].map(([spec, s]) => `import { ${[...s].sort().join(', ')} } from '${spec}';`)];
}
// In <from>, merge a new `import {…} from X` into an existing one from the same X.
function mergeFromImports(text: string) {
  const re = /^import \{ ([^}]*) \} from '([^']*)';$/gm, seen = new Map<string, string>();
  let res = text;
  for (const m of [...text.matchAll(re)]) {
    if (!seen.has(m[2])) { seen.set(m[2], m[0]); continue; }
    const first = seen.get(m[2])!, names = new Set([...first.slice(9, first.indexOf(' }')).split(', '), ...m[1].split(', ')]);
    const merged = `import { ${[...names].sort().join(', ')} } from '${m[2]}';`;
    res = res.replace(m[0] + '\n', '').replace(first, merged); seen.set(m[2], merged);
  }
  return res;
}
