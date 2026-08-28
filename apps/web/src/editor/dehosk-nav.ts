import type * as MonacoT from 'monaco-editor';
import { DEHOSK_LANG_ID } from './dehosk-language';
import { scanSymbols, type Definition, type Range, type SymbolIndex } from './dehosk-symbols';

let cached: { uri: string; version: number; index: SymbolIndex } | undefined;

function indexFor(model: MonacoT.editor.ITextModel): SymbolIndex {
  const uri = model.uri.toString();
  const version = model.getVersionId();
  if (cached && cached.uri === uri && cached.version === version) return cached.index;
  const index = scanSymbols(model.getValue());
  cached = { uri, version, index };
  return index;
}

function toMonacoRange(r: Range): MonacoT.IRange {
  return {
    startLineNumber: r.startLine,
    startColumn: r.startCol,
    endLineNumber: r.endLine,
    endColumn: r.endCol,
  };
}

function toMonacoSymbol(
  monaco: typeof import('monaco-editor'),
  def: Definition,
): MonacoT.languages.DocumentSymbol {
  const kindMap: Record<Definition['kind'], MonacoT.languages.SymbolKind> = {
    validator: monaco.languages.SymbolKind.Class,
    purpose: monaco.languages.SymbolKind.Method,
    fn: monaco.languages.SymbolKind.Function,
    const: monaco.languages.SymbolKind.Constant,
    let: monaco.languages.SymbolKind.Variable,
    param: monaco.languages.SymbolKind.Variable,
    pattern: monaco.languages.SymbolKind.Variable,
  };
  return {
    name: def.name,
    detail: def.kind,
    kind: kindMap[def.kind],
    tags: [],
    range: toMonacoRange(def.range),
    selectionRange: toMonacoRange(def.nameRange),
    children: def.children.map((c) => toMonacoSymbol(monaco, c)),
  };
}

export function registerDehoskNavigation(monaco: typeof import('monaco-editor')): void {
  monaco.languages.registerDocumentSymbolProvider(DEHOSK_LANG_ID, {
    provideDocumentSymbols: (model) => indexFor(model).definitions.map((d) => toMonacoSymbol(monaco, d)),
  });

  monaco.languages.registerDefinitionProvider(DEHOSK_LANG_ID, {
    provideDefinition: (model, position) => {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const def = indexFor(model).defByName.get(word.word);
      if (!def) return null;
      return { uri: model.uri, range: toMonacoRange(def.nameRange) };
    },
  });

  monaco.languages.registerReferenceProvider(DEHOSK_LANG_ID, {
    provideReferences: (model, position, context) => {
      const word = model.getWordAtPosition(position);
      if (!word) return [];
      const index = indexFor(model);
      const locations: MonacoT.languages.Location[] = [];
      if (context.includeDeclaration) {
        const def = index.defByName.get(word.word);
        if (def) locations.push({ uri: model.uri, range: toMonacoRange(def.nameRange) });
      }
      for (const ref of index.refsByName.get(word.word) ?? []) {
        locations.push({ uri: model.uri, range: toMonacoRange(ref.range) });
      }
      return locations;
    },
  });
}
