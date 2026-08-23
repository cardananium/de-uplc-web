//! Thin wasm-bindgen wrapper over the `dehosk` UPLC decompiler.
//!
//! Exposes `decompile_uplc(hex_code, options_json)` and `options_catalogue()`.
//! Options JSON mirrors the dehosk-web `DecompileOptionsDto`; the catalogue is
//! the crate's own option list so the panel does not keep a second copy.
//!
//! The decompiler runs on the current (worker) thread; deep recursion is served by a 64 MB shadow
//! stack sized at link time (see `.cargo/config.toml`) rather than the native large-stack thread.

use serde::Deserialize;
use wasm_bindgen::prelude::*;

use dehosk::decompile::{
    DisplayPolishPasses, OutputLayer, ReadabilityPasses, SimplifyPasses, StructuralRecoveryPasses,
    TypePasses,
};
use dehosk::{decompile, DecompileOptions, ScriptVersion};

mod options_catalogue;

const MAX_HEX_LEN: usize = 4 * 1024 * 1024; // 4 MB of hex (~2 MB bytes)

/// Decompile compiled UPLC bytecode (CBOR/Flat hex) to Aiken-like pseudocode.
///
/// `options_json` is the serialized `DecompileOptionsDto` (empty string → defaults). Returns the
/// rendered code, or a JS error carrying the decompiler's message.
#[wasm_bindgen]
pub fn decompile_uplc(hex_code: &str, options_json: &str) -> Result<String, JsError> {
    console_error_panic_hook::set_once();

    let hex: String = hex_code.chars().filter(|c| !c.is_whitespace()).collect();
    if hex.is_empty() {
        return Err(JsError::new("No UPLC hex provided"));
    }
    if hex.len() > MAX_HEX_LEN {
        return Err(JsError::new("Input too large (max 2 MB of bytecode)"));
    }
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(JsError::new(
            "Input is not hex — paste compiled script bytecode (CBOR/Flat hex / .plutus cborHex)",
        ));
    }

    let dto: DecompileOptionsDto = if options_json.trim().is_empty() {
        DecompileOptionsDto::default()
    } else {
        serde_json::from_str(options_json)
            .map_err(|e| JsError::new(&format!("Invalid options JSON: {e}")))?
    };

    decompile(&hex, dto.into()).map_err(|e| JsError::new(&format!("{e}")))
}

/// The option catalogue as JSON (`version`, `groups`, `defaults`).
///
/// Same wire shape as dehosk-web `GET /api/options`. The panel renders from this
/// so a new crate option shows up without a TypeScript change. `defaults` is the
/// web request (stub-ADTs off, applied_kind Compile), not `DecompileOptions::default()`.
#[wasm_bindgen]
pub fn options_catalogue() -> Result<String, JsError> {
    console_error_panic_hook::set_once();
    options_catalogue::catalogue_json().map_err(|e| JsError::new(&format!("{e}")))
}

fn default_true() -> bool {
    true
}

// ── Options DTO — mirrors dehosk-web `decompiler-web/src/api.rs::DecompileOptionsDto` ────────────

/// Deliberately NOT `#[derive(Default)]`.
///
/// The derive builds the struct from `bool::default()`, ignoring per-field
/// `#[serde(default = "…")]`, so it would disagree with an empty `{}` body.
impl Default for DecompileOptionsDto {
    fn default() -> Self {
        serde_json::from_value(serde_json::json!({}))
            .expect("every field of DecompileOptionsDto declares a serde default")
    }
}

#[derive(Deserialize)]
pub(crate) struct DecompileOptionsDto {
    #[serde(default)]
    safe_mode: bool,
    #[serde(default)]
    script_version: Option<ScriptVersionDto>,
    #[serde(default)]
    synthesize_stub_adts: bool,
    #[serde(default = "default_true")]
    recognize_prelude_constructors: bool,
    #[serde(default = "default_true")]
    decode_church_to_native: bool,
    #[serde(default = "default_true")]
    expect_or_fail: bool,
    #[serde(default)]
    compilable_data_access: bool,
    #[serde(default)]
    ordering_names: bool,
    #[serde(default)]
    output_layer: OutputLayerDto,
    #[serde(default)]
    validator_shape: ValidatorShapeOptionsDto,
    #[serde(default = "SimplifyPassesDto::default")]
    simplify_passes: SimplifyPassesDto,
    #[serde(default = "StructuralRecoveryPassesDto::default")]
    structural_recovery_passes: StructuralRecoveryPassesDto,
    #[serde(default = "ReadabilityPassesDto::default")]
    readability_passes: ReadabilityPassesDto,
    #[serde(default = "DisplayPolishPassesDto::default")]
    display_polish_passes: DisplayPolishPassesDto,
    #[serde(default = "TypePassesDto::default")]
    type_passes: TypePassesDto,
}

#[derive(Deserialize)]
#[serde(default)]
struct SimplifyPassesDto {
    #[serde(default = "default_true")]
    simplify_fp_initial: bool,
    #[serde(default = "default_true")]
    simplify_fp_post_readability: bool,
    #[serde(default = "default_true")]
    inline_single_use: bool,
    #[serde(default = "default_true")]
    inline_fp: bool,
    #[serde(default = "default_true")]
    inline_post_readability: bool,
    #[serde(default = "default_true")]
    dead_let_elim: bool,
    #[serde(default = "default_true")]
    collapse_tail_chains: bool,
}
impl Default for SimplifyPassesDto {
    fn default() -> Self {
        Self {
            simplify_fp_initial: true,
            simplify_fp_post_readability: true,
            inline_single_use: true,
            inline_fp: true,
            inline_post_readability: true,
            dead_let_elim: true,
            collapse_tail_chains: true,
        }
    }
}

#[derive(Deserialize)]
#[serde(default)]
struct StructuralRecoveryPassesDto {
    #[serde(default = "default_true")]
    recover_let_bound_tag_dispatch: bool,
    #[serde(default = "default_true")]
    simplify_double_rec_fn: bool,
    #[serde(default = "default_true")]
    recover_pair_fixpoint: bool,
    #[serde(default = "default_true")]
    simplify_z_combinator: bool,
    #[serde(default = "default_true")]
    extract_complex_when_subjects: bool,
    #[serde(default = "default_true")]
    resolve_immediate_applications: bool,
    #[serde(default = "default_true")]
    resolve_data_case: bool,
}
impl Default for StructuralRecoveryPassesDto {
    fn default() -> Self {
        Self {
            recover_let_bound_tag_dispatch: true,
            simplify_double_rec_fn: true,
            recover_pair_fixpoint: true,
            simplify_z_combinator: true,
            extract_complex_when_subjects: true,
            resolve_immediate_applications: true,
            resolve_data_case: true,
        }
    }
}

#[derive(Deserialize)]
#[serde(default)]
struct ReadabilityPassesDto {
    #[serde(default = "default_true")]
    improve_variable_names: bool,
    #[serde(default = "default_true")]
    flatten_let_chains: bool,
    #[serde(default = "default_true")]
    rename_variables: bool,
    #[serde(default = "default_true")]
    hoist_local_helpers: bool,
    #[serde(default = "default_true")]
    extract_heavy_constants: bool,
}
impl Default for ReadabilityPassesDto {
    fn default() -> Self {
        Self {
            improve_variable_names: true,
            flatten_let_chains: true,
            rename_variables: true,
            hoist_local_helpers: true,
            extract_heavy_constants: true,
        }
    }
}

#[derive(Deserialize)]
#[serde(default)]
struct DisplayPolishPassesDto {
    #[serde(default = "default_true")]
    strip_cosmetic_delays: bool,
    #[serde(default = "default_true")]
    cancel_force_delay_vars: bool,
    #[serde(default = "default_true")]
    normalize_list_cons_literals: bool,
    #[serde(default = "default_true")]
    normalize_display_rewrites: bool,
    #[serde(default = "default_true")]
    eliminate_cps_selectors: bool,
    #[serde(default = "default_true")]
    simplify_boolean_and_identity: bool,
    #[serde(default = "default_true")]
    collapse_eta_pair_selectors: bool,
    #[serde(default = "default_true")]
    resolve_scott_constructor_lambdas_late: bool,
    #[serde(default = "default_true")]
    resolve_data_case_late: bool,
}
impl Default for DisplayPolishPassesDto {
    fn default() -> Self {
        Self {
            strip_cosmetic_delays: true,
            cancel_force_delay_vars: true,
            normalize_list_cons_literals: true,
            normalize_display_rewrites: true,
            eliminate_cps_selectors: true,
            simplify_boolean_and_identity: true,
            collapse_eta_pair_selectors: true,
            resolve_scott_constructor_lambdas_late: true,
            resolve_data_case_late: true,
        }
    }
}

#[derive(Deserialize)]
#[serde(default)]
struct TypePassesDto {
    #[serde(default = "default_true")]
    solve_type_constraints: bool,
    #[serde(default = "default_true")]
    propagate_types: bool,
    #[serde(default = "default_true")]
    resolve_cardano_field_names: bool,
}
impl Default for TypePassesDto {
    fn default() -> Self {
        Self {
            solve_type_constraints: true,
            propagate_types: true,
            resolve_cardano_field_names: true,
        }
    }
}

#[derive(Deserialize)]
enum ScriptVersionDto {
    PlutusV1,
    PlutusV2,
    PlutusV3,
}

#[derive(Deserialize, Default)]
enum OutputLayerDto {
    #[default]
    Decompiled,
    Uplc,
    UplcCanonical,
    RawPseudo,
    PostPipeline,
    PolarityReport,
}
impl From<OutputLayerDto> for OutputLayer {
    fn from(d: OutputLayerDto) -> Self {
        match d {
            OutputLayerDto::Decompiled => OutputLayer::Decompiled,
            OutputLayerDto::Uplc => OutputLayer::Uplc,
            OutputLayerDto::UplcCanonical => OutputLayer::UplcCanonical,
            OutputLayerDto::RawPseudo => OutputLayer::RawPseudo,
            OutputLayerDto::PostPipeline => OutputLayer::PostPipeline,
            OutputLayerDto::PolarityReport => OutputLayer::PolarityReport,
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ValidatorShapeOptionsDto {
    purpose: Option<ValidatorPurposeDto>,
    split_purposes: SplitPurposesDto,
    script_kind: Option<ScriptKindDto>,
    applied_kind: AppliedKindDto,
}

#[derive(Deserialize)]
enum ValidatorPurposeDto {
    Spend,
    Mint,
    Withdraw,
    /// Crate tag is `Certificate` (`ScriptInfo::Certifying`). `Publish` is the
    /// old wire name — still accepted so a stale options bag keeps working.
    #[serde(alias = "Publish")]
    Certificate,
    Vote,
    Propose,
}

#[derive(Deserialize, Default)]
enum SplitPurposesDto {
    #[default]
    Auto,
    Always,
    Never,
}

#[derive(Deserialize)]
enum ScriptKindDto {
    Validator,
    Plain,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum AppliedKindDto {
    Keyword(AppliedKindKeyword),
    RuntimeCount { runtime_count: usize },
}
impl Default for AppliedKindDto {
    fn default() -> Self {
        AppliedKindDto::Keyword(AppliedKindKeyword::Compile)
    }
}

#[derive(Deserialize, Default)]
enum AppliedKindKeyword {
    #[default]
    Compile,
    Runtime,
    Auto,
}

// ── DTO → dehosk options ─────────────────────────────────────────────────────────────────────

impl From<SimplifyPassesDto> for SimplifyPasses {
    fn from(d: SimplifyPassesDto) -> Self {
        Self {
            simplify_fp_initial: d.simplify_fp_initial,
            simplify_fp_post_readability: d.simplify_fp_post_readability,
            inline_single_use: d.inline_single_use,
            inline_fp: d.inline_fp,
            inline_post_readability: d.inline_post_readability,
            dead_let_elim: d.dead_let_elim,
            collapse_tail_chains: d.collapse_tail_chains,
        }
    }
}
impl From<StructuralRecoveryPassesDto> for StructuralRecoveryPasses {
    fn from(d: StructuralRecoveryPassesDto) -> Self {
        Self {
            recover_let_bound_tag_dispatch: d.recover_let_bound_tag_dispatch,
            simplify_double_rec_fn: d.simplify_double_rec_fn,
            recover_pair_fixpoint: d.recover_pair_fixpoint,
            simplify_z_combinator: d.simplify_z_combinator,
            extract_complex_when_subjects: d.extract_complex_when_subjects,
            resolve_immediate_applications: d.resolve_immediate_applications,
            resolve_data_case: d.resolve_data_case,
        }
    }
}
impl From<ReadabilityPassesDto> for ReadabilityPasses {
    fn from(d: ReadabilityPassesDto) -> Self {
        Self {
            improve_variable_names: d.improve_variable_names,
            flatten_let_chains: d.flatten_let_chains,
            rename_variables: d.rename_variables,
            hoist_local_helpers: d.hoist_local_helpers,
            extract_heavy_constants: d.extract_heavy_constants,
        }
    }
}
impl From<DisplayPolishPassesDto> for DisplayPolishPasses {
    fn from(d: DisplayPolishPassesDto) -> Self {
        Self {
            strip_cosmetic_delays: d.strip_cosmetic_delays,
            cancel_force_delay_vars: d.cancel_force_delay_vars,
            normalize_list_cons_literals: d.normalize_list_cons_literals,
            normalize_display_rewrites: d.normalize_display_rewrites,
            eliminate_cps_selectors: d.eliminate_cps_selectors,
            simplify_boolean_and_identity: d.simplify_boolean_and_identity,
            collapse_eta_pair_selectors: d.collapse_eta_pair_selectors,
            resolve_scott_constructor_lambdas_late: d.resolve_scott_constructor_lambdas_late,
            resolve_data_case_late: d.resolve_data_case_late,
        }
    }
}
impl From<TypePassesDto> for TypePasses {
    fn from(d: TypePassesDto) -> Self {
        Self {
            solve_type_constraints: d.solve_type_constraints,
            propagate_types: d.propagate_types,
            resolve_cardano_field_names: d.resolve_cardano_field_names,
        }
    }
}

impl From<ValidatorShapeOptionsDto> for dehosk::decompile::validator_shape::ValidatorShapeOptions {
    fn from(dto: ValidatorShapeOptionsDto) -> Self {
        use dehosk::decompile::validator_meta::ValidatorPurpose as P;
        use dehosk::decompile::validator_shape::{
            AppliedKind as A, ScriptKind as K, SplitPurposes as S,
        };
        Self {
            purpose: dto.purpose.map(|p| match p {
                ValidatorPurposeDto::Spend => P::Spend,
                ValidatorPurposeDto::Mint => P::Mint,
                ValidatorPurposeDto::Withdraw => P::Withdraw,
                ValidatorPurposeDto::Certificate => P::Certificate,
                ValidatorPurposeDto::Vote => P::Vote,
                ValidatorPurposeDto::Propose => P::Propose,
            }),
            split_purposes: match dto.split_purposes {
                SplitPurposesDto::Auto => S::Auto,
                SplitPurposesDto::Always => S::Always,
                SplitPurposesDto::Never => S::Never,
            },
            script_kind: dto.script_kind.map(|k| match k {
                ScriptKindDto::Validator => K::Validator,
                ScriptKindDto::Plain => K::Plain,
            }),
            applied_kind: match dto.applied_kind {
                AppliedKindDto::Keyword(AppliedKindKeyword::Auto) => A::Auto,
                AppliedKindDto::Keyword(AppliedKindKeyword::Compile) => A::Compile,
                AppliedKindDto::Keyword(AppliedKindKeyword::Runtime) => A::Runtime,
                AppliedKindDto::RuntimeCount { runtime_count } => A::RuntimeCount(runtime_count),
            },
        }
    }
}

impl From<DecompileOptionsDto> for DecompileOptions {
    fn from(dto: DecompileOptionsDto) -> Self {
        Self {
            safe_mode: dto.safe_mode,
            script_version: dto.script_version.map(|v| match v {
                ScriptVersionDto::PlutusV1 => ScriptVersion::PlutusV1,
                ScriptVersionDto::PlutusV2 => ScriptVersion::PlutusV2,
                ScriptVersionDto::PlutusV3 => ScriptVersion::PlutusV3,
            }),
            blueprint_hints: None,
            validator_meta: None,
            use_varkind_recovery: true,
            synthesize_stub_adts: dto.synthesize_stub_adts,
            recognize_prelude_constructors: dto.recognize_prelude_constructors,
            decode_church_to_native: dto.decode_church_to_native,
            expect_or_fail: dto.expect_or_fail,
            compilable_data_access: dto.compilable_data_access,
            ordering_names: dto.ordering_names,
            output_layer: dto.output_layer.into(),
            validator_shape: dto.validator_shape.into(),
            simplify_passes: dto.simplify_passes.into(),
            structural_recovery_passes: dto.structural_recovery_passes.into(),
            readability_passes: dto.readability_passes.into(),
            display_polish_passes: dto.display_polish_passes.into(),
            type_passes: dto.type_passes.into(),
            oracle_data_args: Vec::new(),
            oracle_tx: None,
            record_lineage_routes: false,
        }
    }
}
