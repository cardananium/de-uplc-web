use crate::wasm_tools::{wasm_bindgen, JsError};
use pallas_primitives::{
    conway::{Language, MintedTx, Redeemer},
    Fragment,
};
use std::collections::HashMap;
use uplc::{
    ast::{FakeNamedDeBruijn, NamedDeBruijn, Program},
    machine::cost_model::{initialize_cost_model_with_protocol, CostModel, ExBudget},
    machine::runtime::VAN_ROSSEM_PROTOCOL_VERSION,
    tx::{
        iter_redeemers, redeemer_tag_to_string,
        script_context::{
            find_script, PlutusScript, ScriptContext, TxInfo, TxInfoV1, TxInfoV2, TxInfoV3,
        },
        to_plutus_data::ToPlutusData,
        DataLookupTable, ResolvedInput, SlotConfig,
    },
    PlutusData,
};

use super::SessionController;
use crate::debugger_engine::DebuggerError;
use crate::protocol_params::ProtocolParameters;
use crate::utxo::UtxoOutput;

const SLOT_CONFIG_MAINNET: SlotConfig = SlotConfig {
    zero_time: 1596059091000, // Shelley era start
    zero_slot: 4492800,       // Shelley era start slot
    slot_length: 1000,        // 1 second per slot
};

const SLOT_CONFIG_PREPROD: SlotConfig = SlotConfig {
    zero_time: 1654041600000 + 1728000000, // Shelley era start
    zero_slot: 0,                          // Shelley era start slot
    slot_length: 1000,                     // 1 second per slot
};

const SLOT_CONFIG_PREVIEW: SlotConfig = SlotConfig {
    zero_time: 1666656000000, // Shelley era start
    zero_slot: 0,             // Shelley era start slot
    slot_length: 1000,        // 1 second per slot
};

// Conversion from DebuggerError to JsError
impl From<DebuggerError> for JsError {
    fn from(error: DebuggerError) -> Self {
        JsError::from_str(&error.to_string())
    }
}

// Conversion from UtxoConversionError to JsError
impl From<crate::utxo::UtxoConversionError> for JsError {
    fn from(error: crate::utxo::UtxoConversionError) -> Self {
        JsError::from_str(&error.to_string())
    }
}

#[wasm_bindgen]
#[derive(Debug)]
pub struct DebuggerEngine {
    v1_context: Option<TxInfo>,
    v2_context: Option<TxInfo>,
    v3_context: Option<TxInfo>,
    transaction_id: String,
    protocol_params: ProtocolParameters,

    redeemers: HashMap<String, Redeemer>,
    redeemer_scripts: HashMap<String, (PlutusScript, Option<PlutusData>)>,
}

#[wasm_bindgen]
impl DebuggerEngine {
    pub(crate) fn new_internal(
        tx_hex: &str,
        utxos: Vec<UtxoOutput>,
        protocol_params: ProtocolParameters,
        network: &str,
    ) -> Result<Self, JsError> {
        let network = network.to_lowercase().trim().to_string();
        let slot_config = if network == "mainnet" {
            SLOT_CONFIG_MAINNET
        } else if network == "preprod" {
            SLOT_CONFIG_PREPROD
        } else if network == "preview" {
            SLOT_CONFIG_PREVIEW
        } else {
            return Err(JsError::from_str("Invalid network"));
        };

        // Parse transaction from hex
        let tx_bytes =
            hex::decode(tx_hex).map_err(|e| DebuggerError::TransactionParseError(e.to_string()))?;

        let tx = MintedTx::decode_fragment(&tx_bytes)
            .map_err(|e| DebuggerError::TransactionParseError(e.to_string()))?;

        // Calculate transaction ID using hash_transaction
        let tx_body_bytes = tx
            .transaction_body
            .encode_fragment()
            .map_err(|e| DebuggerError::TransactionParseError(e.to_string()))?;
        let tx_hash = pallas_crypto::hash::Hasher::<256>::hash(&tx_body_bytes);
        let tx_id = hex::encode(tx_hash);

        // Convert UtxoOutput to ResolvedInput
        let resolved_inputs: Vec<ResolvedInput> = utxos
            .into_iter()
            .map(|utxo| utxo.try_into())
            .collect::<Result<Vec<_>, _>>()?;

        // Create data lookup table
        let lookup_table = DataLookupTable::from_transaction(&tx, &resolved_inputs);

        let redeemers = tx.transaction_witness_set.redeemer.as_ref().ok_or(
            DebuggerError::TransactionParseError("No redeemers in transaction".to_string()),
        )?;
        let mut redeemers_map = HashMap::new();
        let mut redeemer_scripts = HashMap::new();

        for (key, data, ex_units) in iter_redeemers(redeemers) {
            let redeemer_key = format!("{}:{}", redeemer_tag_to_string(&key.tag), key.index);
            redeemers_map.insert(
                redeemer_key.clone(),
                Redeemer {
                    tag: key.tag,
                    index: key.index,
                    data: data.clone(),
                    ex_units,
                },
            );

            let (script, datum) = find_script(
                &redeemers_map[&redeemer_key],
                &tx,
                &resolved_inputs,
                &lookup_table,
            )
            .map_err(|e| {
                println!("Error {:?}", e);
                e
            })
            .map_err(|_| DebuggerError::ScriptNotFound(redeemer_key.to_string()))?;
            redeemer_scripts.insert(redeemer_key, (script, datum));
        }

        let has_v1_script_redeemer = redeemer_scripts.values().any(|(script, _)| {
            matches!(script, PlutusScript::V1(_))
        });

        let has_v2_script_redeemer = redeemer_scripts.values().any(|(script, _)| {
            matches!(script, PlutusScript::V2(_))
        });

        let has_v3_script_redeemer = redeemer_scripts.values().any(|(script, _)| {
            matches!(script, PlutusScript::V3(_))
        });

        let v1_context = if has_v1_script_redeemer {
            Some(TxInfoV1::from_transaction(&tx, &resolved_inputs, &slot_config)
                .map_err(|e| DebuggerError::TransactionParseError(e.to_string()))?)
        } else {
            None
        };

        let v2_context = if has_v2_script_redeemer {
            Some(TxInfoV2::from_transaction(&tx, &resolved_inputs, &slot_config)
                .map_err(|e| DebuggerError::TransactionParseError(e.to_string()))?)
        } else {
            None
        };

        let v3_context = if has_v3_script_redeemer {
            Some(TxInfoV3::from_transaction(&tx, &resolved_inputs, &slot_config)
                .map_err(|e| DebuggerError::TransactionParseError(e.to_string()))?)
        } else {
            None
        };

        Ok(DebuggerEngine {
            v1_context,
            v2_context,
            v3_context,
            transaction_id: tx_id,
            protocol_params,
            redeemers: redeemers_map,
            redeemer_scripts,
        })
    }

    pub fn new(
        tx_hex: &str,
        utxos_json: &str,
        protocol_params_json: &str,
        network: &str,
    ) -> Result<Self, JsError> {
        crate::wasm_tools::init_panic_hook();

        let utxos = serde_json::from_str::<Vec<UtxoOutput>>(utxos_json)
            .map_err(|e| DebuggerError::TransactionParseError(e.to_string()))?;

        let protocol_params = serde_json::from_str::<ProtocolParameters>(protocol_params_json)
            .map_err(|e| DebuggerError::TransactionParseError(e.to_string()))?;

        Self::new_internal(tx_hex, utxos, protocol_params, network)
    }

    /// Gets list of available redeemers in the transaction
    pub fn get_redeemers(&self) -> Result<Vec<String>, JsError> {
        Ok(self.redeemers.keys().cloned().collect())
    }

    /// Gets the transaction ID
    pub fn get_transaction_id(&self) -> Result<String, JsError> {
        Ok(self.transaction_id.clone())
    }

    /// Initializes a new debug session for a specific redeemer
    pub fn init_debug_session(&mut self, redeemer_str: &str) -> Result<SessionController, JsError> {
        // Parse redeemer string to find the specific redeemer
        let parts: Vec<&str> = redeemer_str.split(":").collect();
        if parts.len() != 2 {
            return Err(JsError::from_str(&format!(
                "Redeemer not found: {}",
                redeemer_str
            )));
        }

        let redeemer = self
            .redeemers
            .get(redeemer_str)
            .ok_or(DebuggerError::RedeemerNotFound(redeemer_str.to_string()))?;

        let (script, datum) = self
            .redeemer_scripts
            .get(redeemer_str)
            .ok_or(DebuggerError::ScriptNotFound(redeemer_str.to_string()))?;

        let script_hash = compute_script_hash(script);

        let language = match script {
            PlutusScript::V1(_) => Language::PlutusV1,
            PlutusScript::V2(_) => Language::PlutusV2,
            PlutusScript::V3(_) => Language::PlutusV3,
        };
        let cost_model = self.get_const_model(&language)?;
        let (program, script_context) = self.build_program(redeemer, script, datum.as_ref())?;
        let upper_bound_budget = ExBudget::max();
        // The declared limit of a tx session: exactly what this redeemer's witness claims in
        // `ex_units`. It is the only honest denominator for "how much of its budget did it use".
        let declared_budget = ExBudget {
            mem: redeemer.ex_units.mem as i64,
            cpu: redeemer.ex_units.steps as i64,
        };

        SessionController::new(
            script_hash,
            language,
            program,
            Some(script_context),
            None, // raw_context_data — tx mode has the typed ScriptContext above
            cost_model,
            upper_bound_budget,
            Some(declared_budget),
            redeemer_str.to_string(),
            None, // no purpose override in tx mode — the typed ScriptContext already names it
        )
    }

    fn build_program(
        &self,
        redeemer: &Redeemer,
        script: &PlutusScript,
        datum: Option<&PlutusData>,
    ) -> Result<(Box<Program<NamedDeBruijn>>, ScriptContext), JsError> {
        let mut buffer = Vec::new();
        let initial_program = Program::<FakeNamedDeBruijn>::from_cbor(&script, &mut buffer)
            .map(Into::<Program<NamedDeBruijn>>::into)
            .map_err(|e| DebuggerError::ProgramBuildError(e.to_string()))?;

        let script_context = match script {
            PlutusScript::V1(_) => self
                .v1_context
                .as_ref()
                .map(|ctx| ctx.clone().into_script_context(redeemer, datum))
                .ok_or(DebuggerError::ScriptContextBuildError(format!(
                    "Failed to get script context for script: {:?}",
                    script
                ))),
            PlutusScript::V2(_) => self
                .v2_context
                .as_ref()
                .map(|ctx| ctx.clone().into_script_context(redeemer, datum))
                .ok_or(DebuggerError::ScriptContextBuildError(format!(
                    "Failed to get script context for script: {:?}",
                    script
                ))),
            PlutusScript::V3(_) => self
                .v3_context
                .as_ref()
                .map(|ctx| ctx.clone().into_script_context(redeemer, datum))
                .ok_or(DebuggerError::ScriptContextBuildError(format!(
                    "Failed to get script context for script: {:?}",
                    script
                ))),
        }?
        .ok_or(DebuggerError::ScriptContextBuildError(format!(
            "Failed to build script context for script: {:?}",
            script
        )))?;

        let program = match script_context {
            ScriptContext::V1V2 { .. } => if let Some(datum) = datum {
                initial_program.apply_data(datum.clone())
            } else {
                initial_program
            }
            .apply_data(redeemer.data.clone())
            .apply_data(script_context.to_plutus_data()),

            ScriptContext::V3 { .. } => initial_program.apply_data(script_context.to_plutus_data()),
        };

        Ok((Box::new(program), script_context))
    }

    fn get_const_model(&self, language: &Language) -> Result<CostModel, JsError> {
        let cost_models = self
            .protocol_params
            .cost_models
            .as_ref()
            .map(|cost_models| match language {
                Language::PlutusV1 => &cost_models.plutus_v1,
                Language::PlutusV2 => &cost_models.plutus_v2,
                Language::PlutusV3 => &cost_models.plutus_v3,
            })
            .into_iter()
            .flatten()
            .next()
            .ok_or(DebuggerError::TransactionParseError(format!(
                "No cost models in protocol parameters for language {:?}",
                language,
            )))?;

        // Protocol-aware builtin semantics: feed the tx's real protocol major version so V3 at
        // protocol >= 11 (Van Rossem) uses VariantE (UTF-8 string costing) rather than C, and V1/V2
        // pick the era-correct variant. `protocol_version` is a REQUIRED field on ProtocolParameters
        // (load fails if absent), so major is always the genuine chain value here — never a stale
        // default. NOTE: the latest de-uplc uplc moved this fixture's exUnits 98887182 -> 117002990
        // (current Chang-era V2 costing); that is the engine bump, NOT this protocol-aware call
        // (which is a no-op at the fixture's major=10 → semantics B/C either way).
        let cost_models = initialize_cost_model_with_protocol(
            &language,
            self.protocol_params.protocol_version.major as u16,
            cost_models,
        );
        Ok(cost_models)
    }
}

fn compute_script_hash(script: &PlutusScript) -> String {
    let (language, bytes) = match script {
        PlutusScript::V1(script) => (Language::PlutusV1, &script.0),
        PlutusScript::V2(script) => (Language::PlutusV2, &script.0),
        PlutusScript::V3(script) => (Language::PlutusV3, &script.0),
    };
    script_hash_hex(&language, bytes)
}

/// The on-chain script hash: `blake2b-224(<language tag byte> ‖ script bytes)`, tag 1/2/3 for
/// V1/V2/V3 — the ledger's rule, expressed by pallas' `hash_tagged`.
///
/// `script_bytes` must be the CANONICAL serialised script, i.e. the bytes the witness set carries
/// as its CBOR bytestring payload: for the compiled scripts every toolchain emits that is the
/// `.plutus` `cborHex` form `59xxxx…` (a CBOR bytestring whose content is the flat program), NOT
/// the flat program alone. Hashing the flat bytes instead produces a perfectly plausible-looking
/// digest for a script that does not exist on chain, so callers normalise first — see
/// `decode_flat_program`, which hands back exactly these bytes for every wrapping it accepts.
fn script_hash_hex(language: &Language, script_bytes: &[u8]) -> String {
    use pallas_crypto::hash::Hasher;
    let tag = match language {
        Language::PlutusV1 => 1u8,
        Language::PlutusV2 => 2,
        Language::PlutusV3 => 3,
    };
    hex::encode(Hasher::<224>::hash_tagged(script_bytes, tag))
}

/// Map a UI-supplied language string ("V1"/"V2"/"V3", case-insensitive) to a Plutus `Language`,
/// defaulting to V3. The language selects both the available builtins and the cost model.
fn parse_language(language: &str) -> Language {
    match language.to_lowercase().trim() {
        "v1" | "plutusv1" | "1" => Language::PlutusV1,
        "v2" | "plutusv2" | "2" => Language::PlutusV2,
        _ => Language::PlutusV3,
    }
}

/// Parse a plain UPLC program from EITHER textual syntax (`(program 1.1.0 …)`) or hex of its
/// (possibly double-) CBOR-wrapped flat encoding (the `.plutus` `cborHex` form). Used for the
/// context-free "debug a bare script" flow — no transaction, redeemer, datum or script context.
///
/// The second element is the CANONICAL serialised script (what `script_hash_hex` wants), or `None`
/// for textual input: text has no canonical bytes, and re-encoding it here would produce a
/// confident-looking hash of OUR flat encoder's output rather than of any script on chain.
fn parse_program_any(src: &str) -> Result<(Program<NamedDeBruijn>, Option<Vec<u8>>), JsError> {
    let trimmed = src.trim();
    if trimmed.is_empty() {
        return Err(DebuggerError::ProgramBuildError("Empty program source".to_string()).into());
    }
    // Textual UPLC syntax starts with '(' — parse names then resolve to de Bruijn indices.
    if trimmed.starts_with('(') {
        let named = uplc::parser::program(trimmed)
            .map_err(|e| DebuggerError::ProgramBuildError(format!("UPLC parse error: {}", e)))?;
        let program = named
            .to_named_debruijn()
            .map_err(|e| DebuggerError::ProgramBuildError(format!("name resolution failed: {:?}", e)))?;
        return Ok((program, None));
    }
    // Otherwise treat it as hex of the flat bytes (raw, single- or double-CBOR-wrapped).
    let bytes = hex::decode(trimmed).map_err(|_| {
        DebuggerError::ProgramBuildError(
            "Program is neither UPLC text (starting with '(') nor valid hex.".to_string(),
        )
    })?;
    decode_flat_program(&bytes).map(|(p, canonical)| (p, Some(canonical)))
}

/// Wrap raw flat bytes in a CBOR byte string — the missing layer that turns a raw-flat input into
/// the canonical serialised script.
fn cbor_wrap(flat: &[u8]) -> Vec<u8> {
    let mut enc = pallas_codec::minicbor::Encoder::new(Vec::with_capacity(flat.len() + 9));
    enc.bytes(flat).expect("writing to a Vec never fails");
    enc.into_writer()
}

/// Decode a `Program<NamedDeBruijn>` from flat bytes, tolerating the common wrappings of a
/// compiled script: single-CBOR (`cborHex` of flat), double-CBOR (aiken's `.plutus` envelope),
/// or raw flat. CBOR forms are tried first since that is what `.plutus`/`PlutusScriptV*` carry.
///
/// Also returns the CANONICAL form of the same script — single-CBOR-wrapped, which is what the
/// ledger hashes — so the three accepted spellings of one script all hash alike. The normalisation
/// is produced HERE, in the same branch that decided how the input was wrapped, because a second
/// sniffing pass elsewhere could disagree with this one and hash a different script than it ran.
fn decode_flat_program(bytes: &[u8]) -> Result<(Program<NamedDeBruijn>, Vec<u8>), JsError> {
    // 1) double CBOR wrap: cbor(cbor(flat)) — strip the layer a witness set adds, so the inner
    //    bytes ARE the canonical form. Tried FIRST because `from_cbor` unwraps exactly one layer
    //    and then unflats whatever it finds: given a double-wrapped script it hands the still-
    //    wrapped `59xxxx…` to the flat decoder, which reads the byte-string header as a version
    //    triple and returns a nonsense program instead of an error. Requiring the INNER bytes to be
    //    a byte string too (which `from_cbor(inner)` does) is what tells the two shapes apart: a
    //    singly-wrapped script's content is a flat program starting `01 …`, never a CBOR wrapper.
    let mut decoder = pallas_codec::minicbor::Decoder::new(bytes);
    if let Ok(inner) = decoder.bytes() {
        let mut buf = Vec::new();
        if let Ok(p) = Program::<FakeNamedDeBruijn>::from_cbor(inner, &mut buf) {
            return Ok((p.into(), inner.to_vec()));
        }
    }
    // 2) single CBOR wrap: cbor(flat) — already canonical.
    let mut buf = Vec::new();
    if let Ok(p) = Program::<FakeNamedDeBruijn>::from_cbor(bytes, &mut buf) {
        return Ok((p.into(), bytes.to_vec()));
    }
    // 3) raw flat (no CBOR wrapper) — add the byte-string header the canonical form carries.
    if let Ok(p) = Program::<FakeNamedDeBruijn>::from_flat(bytes) {
        return Ok((p.into(), cbor_wrap(bytes)));
    }
    Err(DebuggerError::ProgramBuildError(
        "Failed to decode UPLC program from hex (tried CBOR, double-CBOR and raw flat).".to_string(),
    )
    .into())
}

/// Build a debug session directly from a plain UPLC program — NO transaction, redeemer, datum or
/// script context. `program_src` is UPLC text or hex (see `parse_program_any`); `language` selects
/// the builtins + cost model ("V1"/"V2"/"V3", default V3). The machine runs with an effectively
/// unbounded budget (so you can step a script that would overspend on chain), and nothing declares
/// a limit — the budget panel and the profile print `—` rather than a share of a made-up cap.
#[wasm_bindgen]
pub fn new_session_from_program(program_src: &str, language: &str) -> Result<SessionController, JsError> {
    crate::wasm_tools::init_panic_hook();
    let lang = parse_language(language);
    let (program, canonical) = parse_program_any(program_src)?;
    let cost_model = match lang {
        Language::PlutusV1 => CostModel::v1(),
        Language::PlutusV2 => CostModel::v2(),
        Language::PlutusV3 => CostModel::v3(),
    };
    SessionController::new(
        // The script hash needs nothing but these bytes and the language, so a hex-loaded program
        // reports the same on-chain hash a transaction would. Text input has no canonical bytes:
        // "" (= unknown, printed as `—`) is the truthful answer, not a hash of our re-encoding.
        canonical.map_or_else(String::new, |bytes| script_hash_hex(&lang, &bytes)),
        lang,
        Box::new(program),
        None, // no script context
        None, // no raw context data
        cost_model,
        ExBudget::max(), // machine cap — don't budget-error while debugging
        None,            // nothing declared ExUnits here, so there is no limit to report
        String::new(),   // no redeemer
        None,            // no context and no link field: nothing names a purpose
    )
}

/// Decode a `PlutusData` argument from CBOR hex (datum / redeemer / script-context).
fn decode_plutus_data(cbor_hex: &str) -> Result<PlutusData, JsError> {
    let bytes = hex::decode(cbor_hex.trim())
        .map_err(|e| DebuggerError::ProgramBuildError(format!("invalid PlutusData hex: {e}")))?;
    pallas_codec::minicbor::decode::<PlutusData>(&bytes)
        .map_err(|e| DebuggerError::ProgramBuildError(format!("invalid PlutusData CBOR: {e}")).into())
}

/// Decode the script-context argument from EITHER a named `SerializableScriptContext` JSON (when it
/// starts with `{`) — encoded back to PlutusData via the forward encoder — or CBOR hex.
fn decode_context(src: &str) -> Result<PlutusData, JsError> {
    let t = src.trim();
    if t.starts_with('{') {
        let ctx: crate::script_context::SerializableScriptContext = serde_json::from_str(t)
            .map_err(|e| DebuggerError::ProgramBuildError(format!("invalid script-context JSON: {e}")))?;
        return crate::script_context::from_plutus_data::script_context_to_data(&ctx)
            .map_err(|e| DebuggerError::ProgramBuildError(format!("encode script context: {e}")).into());
    }
    decode_plutus_data(t)
}

/// Config for the "script + manually-supplied args" session (the URL deep-link path). Everything
/// except `script` is optional — provide only the args your validator needs.
#[derive(serde::Deserialize)]
struct PartsConfig {
    /// The validator program: UPLC text or hex (CBOR/Flat).
    script: String,
    /// Plutus version "V1"/"V2"/"V3" (selects the default cost model).
    #[serde(default)]
    language: String,
    /// The script context applied LAST (V3: the whole ScriptContext). Either PlutusData CBOR hex,
    /// or a named `SerializableScriptContext` JSON (auto-detected by a leading `{`, see
    /// `decode_context`) — the same named shape `getTxScriptContext` emits.
    #[serde(default)]
    context: Option<String>,
    /// PlutusData CBOR hex applied after the datum — the redeemer (V1/V2).
    #[serde(default)]
    redeemer: Option<String>,
    /// PlutusData CBOR hex applied FIRST — the spend datum (V1/V2 spend only).
    #[serde(default)]
    datum: Option<String>,
    /// Cost-model params for the script's language (flat i64 list). Omit → the built-in default model.
    #[serde(default)]
    cost_models: Option<Vec<i64>>,
    /// The ExUnits the redeemer DECLARED, as the flat pair `[cpu, mem]` — the one thing a parts
    /// link cannot derive from its own contents (they live in the tx's witness set). Omit → the
    /// session reports no limit at all. Anything that isn't exactly two non-negative integers is
    /// ignored (see `lenient_i64_list` / `declared_ex_units`).
    #[serde(default, deserialize_with = "lenient_i64_list")]
    ex_units: Option<Vec<i64>>,
    /// Protocol major version — selects builtin semantics (>= 11 = Van Rossem / PV11 UTF-8 string
    /// costing). Only consulted when `cost_models` is given. Default: VAN_ROSSEM (current mainnet).
    #[serde(default)]
    protocol_version: Option<u16>,
    /// What the script is being run FOR, as a short free-form label ("spend", "Spending #0", …).
    /// Optional, and normally unnecessary: the purpose is inside `context` and is derived from it.
    /// It exists for the links that cannot be derived from — no context, or a context that is valid
    /// PlutusData but not a ScriptContext — and it OVERRIDES the derived value when both exist,
    /// because whoever minted the link knows which redeemer this was and we are only guessing.
    /// Read leniently, for the same reason `ex_units` is: a generator that puts a number here must
    /// lose the label, not the whole link.
    #[serde(default, deserialize_with = "lenient_string")]
    purpose: Option<String>,
}

/// A string field that ignores anything that isn't a string, instead of failing the config parse.
fn lenient_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    use serde::Deserialize;
    Ok(match Option::<serde_json::Value>::deserialize(d)? {
        Some(serde_json::Value::String(s)) => Some(s),
        _ => None,
    })
}

/// Read a `[i64, …]` field WITHOUT letting a malformed one abort the whole config. The default
/// `Vec<i64>` deserializer errors on the first non-integer element, which would turn a typo in a
/// shared link into "the link doesn't open"; here any shape that isn't a clean list of integers
/// simply becomes `None`.
fn lenient_i64_list<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Vec<i64>>, D::Error> {
    use serde::Deserialize;
    let value = Option::<serde_json::Value>::deserialize(d)?;
    Ok(match value {
        Some(serde_json::Value::Array(items)) => {
            items.iter().map(|x| x.as_i64()).collect::<Option<Vec<i64>>>()
        }
        _ => None,
    })
}

/// The declared ExUnits of a parts session: exactly `[cpu, mem]`, both non-negative. Anything else
/// is IGNORED — a wrong-length or negative pair means we don't know the limit, and inventing one
/// (or refusing to open the link over it) are both worse than reporting no limit.
fn declared_ex_units(ex_units: Option<&Vec<i64>>) -> Option<ExBudget> {
    match ex_units.map(Vec::as_slice) {
        Some(&[cpu, mem]) if cpu >= 0 && mem >= 0 => Some(ExBudget { mem, cpu }),
        _ => None,
    }
}

/// Build a debug session from a validator + manually-supplied Data arguments (NO transaction).
///
/// The program is applied, in standard validator order, to whichever of `datum`, `redeemer`,
/// `context` are present (V1/V2 spend = all three; V1/V2 other = redeemer + context; V3 = context
/// only). The session has no typed `ScriptContext` (the context is applied as a Data constant, so it
/// is still visible/steppable in the term). `cost_models`, when given, drives budget accounting;
/// otherwise the built-in default model for the language is used. `ex_units`, when given, is the
/// declared `[cpu, mem]` the budget panel and the profile measure against — without it the session
/// declares no limit. `config_json` is a `PartsConfig`.
#[wasm_bindgen]
pub fn new_session_from_parts(config_json: &str) -> Result<SessionController, JsError> {
    crate::wasm_tools::init_panic_hook();
    let cfg: PartsConfig = serde_json::from_str(config_json)
        .map_err(|e| JsError::from_str(&format!("invalid parts config: {e}")))?;
    let lang = parse_language(&cfg.language);
    let (mut program, canonical) = parse_program_any(&cfg.script)?;
    // Hash the script BEFORE the args are applied: the on-chain hash is of the validator alone, and
    // `apply_data` below deliberately builds a different program (the one being stepped).
    let script_hash = canonical.map_or_else(String::new, |bytes| script_hash_hex(&lang, &bytes));
    if let Some(d) = &cfg.datum {
        program = program.apply_data(decode_plutus_data(d)?);
    }
    if let Some(r) = &cfg.redeemer {
        program = program.apply_data(decode_plutus_data(r)?);
    }
    // Keep the decoded context Data so "Show context" can render it (it's also applied to the
    // program). The context may be a named `SerializableScriptContext` JSON or CBOR hex.
    let raw_context = match &cfg.context {
        Some(c) => {
            let data = decode_context(c)?;
            program = program.apply_data(data.clone());
            Some(data)
        }
        None => None,
    };
    let cost_model = match &cfg.cost_models {
        // No tx here, so no chain protocol version — default to VAN_ROSSEM (current mainnet).
        Some(costs) => initialize_cost_model_with_protocol(
            &lang,
            cfg.protocol_version.unwrap_or(VAN_ROSSEM_PROTOCOL_VERSION),
            costs,
        ),
        None => match lang {
            Language::PlutusV1 => CostModel::v1(),
            Language::PlutusV2 => CostModel::v2(),
            Language::PlutusV3 => CostModel::v3(),
        },
    };
    SessionController::new(
        script_hash,
        lang,
        Box::new(program),
        None,        // no typed ScriptContext
        raw_context, // raw context Data (rendered by "Show context")
        cost_model,
        ExBudget::max(),
        declared_ex_units(cfg.ex_units.as_ref()), // whatever the link carried, or no limit at all
        String::new(),
        cfg.purpose, // the link's override; absent → derived from the context, if it decodes
    )
}
