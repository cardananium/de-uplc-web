/** Thin wrapper over @vscode/codicons. `name` is the codicon id without the `codicon-` prefix.
 *  `spin` adds the package's opt-in rotation (used for the Running status). */
export function Codicon({ name, title, spin }: { name: string; title?: string; spin?: boolean }) {
  return <span className={`codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}`} aria-hidden title={title} />;
}
