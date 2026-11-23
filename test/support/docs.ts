import { readFileSync } from 'node:fs';

/**
 * The service's handbook and changelog, for tests that check what they
 * state against what the service does (metrics, troubleshooting steps,
 * release notes).
 */
export function readDoc(name: 'README.md' | 'CHANGELOG.md'): string {
  return readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
}

/** Number of leading spaces of a line. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The list item of `markdown` that starts with `- ${start}`, with its
 * continuation lines, joined into one line (wrapping removed).
 */
export function listItem(markdown: string, start: string): string {
  const lines = markdown.split('\n');
  const first = lines.findIndex((line) =>
    line.trimStart().startsWith(`- ${start}`),
  );
  const head = lines[first];
  if (head === undefined) throw new Error(`No list item "- ${start}…"`);
  const item = [head.trim()];
  for (const line of lines.slice(first + 1)) {
    if (line.trim() === '' || indentOf(line) <= indentOf(head)) break;
    item.push(line.trim());
  }
  return item.join(' ');
}

/** The row of the README's metrics table whose first cell names `metric`. */
export function metricsTableRow(readme: string, metric: string): string {
  const row = readme
    .split('\n')
    .map((line) => line.trim())
    .find(
      (line) =>
        line.startsWith('|') &&
        (line.split('|')[1] ?? '').includes(`\`${metric}\``),
    );
  if (row === undefined) throw new Error(`No metrics table row for ${metric}`);
  return row;
}

/** The `## [version]` section of the CHANGELOG, up to the next release. */
export function changelogRelease(changelog: string, version: string): string {
  const start = changelog.indexOf(`\n## [${version}]`);
  if (start < 0) throw new Error(`No CHANGELOG release ${version}`);
  const end = changelog.indexOf('\n## [', start + 1);
  return changelog.slice(start, end < 0 ? undefined : end);
}
