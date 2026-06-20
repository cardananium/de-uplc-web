import { DebuggerContext } from '../common';

/**
 * Parse transaction file content into a DebuggerContext. Extracted verbatim from the original
 * `DebuggerManager.readTransactionContext`, except it takes the already-read file *content*
 * (browser File API / paste / drop) instead of a filesystem path — so no `fs`.
 *
 * Supported inputs:
 *  - JSON `DebuggerContext` (detected by a `transaction` key)
 *  - plain CBOR hex (optionally `0x`-prefixed)
 *  - otherwise the trimmed text is used as the raw transaction
 */
export function parseTransactionContext(content: string): DebuggerContext {
  // Try to parse as JSON first (DebuggerContext)
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && 'transaction' in parsed) {
      return {
        utxos: parsed.utxos,
        protocolParams: parsed.protocolParams,
        network: parsed.network,
        customEndpoint: parsed.customEndpoint,
        transaction: parsed.transaction,
      } as DebuggerContext;
    }
  } catch {
    // Not valid JSON, continue to try other formats
  }

  const trimmedContent = content.trim();
  const hexPattern = /^(0x)?[0-9a-fA-F]+$/;

  if (hexPattern.test(trimmedContent)) {
    const transaction = trimmedContent.startsWith('0x') ? trimmedContent.slice(2) : trimmedContent;
    return {
      utxos: undefined,
      protocolParams: undefined,
      network: undefined,
      transaction,
    };
  }

  // If not hex, treat as raw transaction bytes/text
  return {
    utxos: undefined,
    protocolParams: undefined,
    network: undefined,
    transaction: trimmedContent,
  };
}
