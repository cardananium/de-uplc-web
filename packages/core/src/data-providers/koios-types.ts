export interface KoiosUtxoRefRequest {
  _utxo_refs: Array<string>;
  _extended?: boolean;
  _scripts?: boolean;
  _assets?: boolean;
  _bytecode?: boolean;
}

export interface KoiosTxCborResponse {
  tx_hash: string;
  block_hash: string;
  block_height: number;
  epoch_no: number;
  absolute_slot: number;
  tx_timestamp: number;
  cbor: string;
}

export interface KoiosUtxoInfo {
  tx_hash: string;
  address: string;
  tx_index: number;
  value: string;
  asset_list?: Array<{
    policy_id: string;
    asset_name: string;
    fingerprint: string;
    decimals?: number;
    quantity: string;
  }>;
  datum_hash?: string;
  inline_datum?: {
    bytes: string;
    value: any;
  };
  reference_script?: {
    hash: string;
    size: number;
    type: 'plutusV1' | 'plutusV2' | 'plutusV3' | 'native' | 'timelock' | 'multisig';
    bytes?: string;
    value?: any;
  };
  block_height?: number;
  block_time?: number;
}

export interface KoiosCliProtocolParams {
  [key: string]: any;
}

export interface KoiosError {
  error: string;
  hint?: string;
}

export interface KoiosQueryParams {
  select?: string;
  limit?: number;
  offset?: number;
  order?: string;
  [filter: string]: any;
}