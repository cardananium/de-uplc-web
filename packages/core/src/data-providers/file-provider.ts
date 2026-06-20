import {
  DataProvider,
} from './data-provider.interface';
import { Network, ProtocolParameters, UtxoOutput, UtxoReference } from '../common';

export interface DataFile {
  utxos: UtxoOutput[];
  protocolParams: ProtocolParameters;
}

export interface FileProviderConfig {
  /** Parsed offline data (UTXOs + protocol params), or a raw JSON string to parse. */
  data?: DataFile | string;
  enabled: boolean;
}

/**
 * In-memory offline data provider. The browser has no filesystem, so instead of reading a
 * path this provider holds data the platform supplied (loaded via the File API / IndexedDB).
 * Read/validate/filter logic is unchanged from the original FileProvider; the fs-backed
 * path resolution and write-to-disk methods were removed (persistence is a platform concern).
 */
export class FileProvider implements DataProvider {
  private readonly enabled: boolean;
  private data: DataFile | undefined;

  constructor(config: FileProviderConfig) {
    this.enabled = config.enabled;
    this.data = config.data === undefined ? undefined : FileProvider.parse(config.data);
  }

  private static parse(input: DataFile | string): DataFile {
    const data: DataFile = typeof input === 'string' ? JSON.parse(input) : input;
    if (!data || !data.utxos || !Array.isArray(data.utxos)) {
      throw new Error('Invalid data file: missing or invalid utxos array');
    }
    if (!data.protocolParams || typeof data.protocolParams !== 'object') {
      throw new Error('Invalid data file: missing or invalid protocolParameters object');
    }
    return data;
  }

  private requireData(): DataFile {
    if (!this.enabled) {
      throw new Error('FileProvider is disabled');
    }
    if (!this.data) {
      throw new Error('FileProvider has no data loaded');
    }
    return this.data;
  }

  /**
   * Get information about specific UTXOs by their references.
   * Filters the in-memory data by provided references.
   */
  async getUtxoInfo(utxoRefs: UtxoReference[], _network: Network): Promise<UtxoOutput[]> {
    const data = this.requireData();
    return data.utxos.filter(utxo =>
      utxoRefs.some(ref =>
        ref.txHash === utxo.txHash && ref.outputIndex === utxo.outputIndex
      )
    );
  }

  /**
   * Get current protocol parameters from the in-memory data.
   */
  async getProtocolParameters(): Promise<ProtocolParameters> {
    return this.requireData().protocolParams;
  }

  getProviderName(): string {
    return 'File Provider';
  }
}
