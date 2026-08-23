//! Wire types for the decompilation-option catalogue.
//!
//! Same shape as dehosk-web `GET /api/options`. The crate owns the option list;
//! these types are the WIRE for it so a new `OptionKind` is a compile error here
//! rather than a silently-dropped control.

use serde::Serialize;

use crate::DecompileOptionsDto;
use dehosk::DecompileOptions;

/// The object the frontend renders the options panel from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionCatalogueDto {
    pub version: u32,
    pub groups: Vec<OptionGroupDto>,
    /// Web request defaults (stub-ADTs off, applied_kind Compile), not the crate's.
    pub defaults: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionGroupDto {
    pub id: &'static str,
    pub title: &'static str,
    pub summary: &'static str,
    pub detail: &'static [&'static str],
    pub master_path: Option<&'static [&'static str]>,
    pub options: Vec<OptionDescriptorDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionDescriptorDto {
    pub path: &'static [&'static str],
    pub field: &'static str,
    pub label: &'static str,
    pub summary: &'static str,
    pub detail: &'static [&'static str],
    pub cli_flag: Option<&'static str>,
    pub kind: OptionKindDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OptionKindDto {
    Toggle,
    Choice {
        unset: Option<&'static str>,
        choices: Vec<OptionChoiceDto>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionChoiceDto {
    pub value: &'static str,
    pub label: &'static str,
    pub summary: &'static str,
    pub payload: Option<ChoicePayloadDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChoicePayloadDto {
    Count {
        key: &'static str,
        min: u32,
        default: u32,
    },
}

impl OptionCatalogueDto {
    pub fn from_catalogue(defaults: serde_json::Value) -> Self {
        let groups = dehosk::decompile::options::GROUPS
            .iter()
            .map(|group| OptionGroupDto {
                id: group.id.token(),
                title: group.title,
                summary: group.summary,
                detail: group.detail,
                master_path: group.master_path,
                options: dehosk::decompile::options::ui_options_in(group.id)
                    .into_iter()
                    .filter_map(OptionDescriptorDto::from_entry)
                    .collect(),
            })
            .collect();
        Self {
            version: dehosk::decompile::options::CATALOGUE_VERSION,
            groups,
            defaults,
        }
    }
}

impl OptionDescriptorDto {
    pub fn from_entry(entry: &'static dehosk::decompile::options::OptionEntry) -> Option<Self> {
        use dehosk::decompile::options::Exposure;
        match entry.exposure {
            Exposure::Ui {
                label,
                group: _,
                kind,
                cli_flag,
            } => Some(Self {
                path: entry.path,
                field: entry.field,
                label,
                summary: entry.summary,
                detail: entry.detail,
                cli_flag,
                kind: OptionKindDto::from_kind(kind),
            }),
            Exposure::Nested { .. } | Exposure::Internal { .. } => None,
        }
    }
}

impl OptionKindDto {
    pub fn from_kind(kind: dehosk::decompile::options::OptionKind) -> Self {
        use dehosk::decompile::options::OptionKind;
        match kind {
            OptionKind::Toggle => Self::Toggle,
            OptionKind::Choice { choices, unset } => Self::Choice {
                unset,
                choices: choices
                    .iter()
                    .map(|choice| OptionChoiceDto {
                        value: choice.value,
                        label: choice.label,
                        summary: choice.summary,
                        payload: choice.payload.map(ChoicePayloadDto::from_payload),
                    })
                    .collect(),
            },
        }
    }
}

impl ChoicePayloadDto {
    pub fn from_payload(payload: dehosk::decompile::options::ChoicePayload) -> Self {
        use dehosk::decompile::options::ChoicePayload;
        match payload {
            ChoicePayload::Count { key, min, default } => Self::Count { key, min, default },
        }
    }
}

/// Catalogue JSON for the wasm export. `defaults` is the web request, not
/// `DecompileOptions::default()`.
pub fn catalogue_json() -> Result<String, serde_json::Error> {
    serde_json::to_string(&OptionCatalogueDto::from_catalogue(default_options_json()))
}

/// Built by reading each catalogue path out of the DEFAULT REQUEST — not out
/// of `DecompileOptions::default()`.
///
/// The difference is load-bearing: the web starts with `synthesize_stub_adts:
/// false` (crate default `true`) and `applied_kind: Compile` (crate default
/// `Auto`).
fn default_options_json() -> serde_json::Value {
    use dehosk::decompile::options::{ChoicePayload, OptionKind, OptionValue, ui_options};

    let defaults: DecompileOptions = DecompileOptionsDto::default().into();
    let mut root = serde_json::Map::new();

    for entry in ui_options() {
        let value = defaults
            .get(entry.path)
            .expect("every catalogue-exposed option is readable");
        let json = match value {
            OptionValue::Bool(b) => serde_json::Value::Bool(b),
            OptionValue::Choice(None) => serde_json::Value::Null,
            OptionValue::Choice(Some(token)) => serde_json::Value::String(token.to_string()),
            OptionValue::Count(n) => {
                let key = entry
                    .ui()
                    .and_then(|(_, _, kind, _)| match kind {
                        OptionKind::Choice { choices, .. } => {
                            choices.iter().find_map(|c| match c.payload {
                                Some(ChoicePayload::Count { key, .. }) => Some(key),
                                None => None,
                            })
                        }
                        OptionKind::Toggle => None,
                    })
                    .expect("a count-valued option declares a count payload");
                serde_json::json!({ key: n })
            }
        };
        insert_at(&mut root, entry.path, json);
    }

    serde_json::Value::Object(root)
}

fn insert_at(
    root: &mut serde_json::Map<String, serde_json::Value>,
    path: &[&str],
    value: serde_json::Value,
) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut cursor = root;
    for segment in parents {
        cursor = cursor
            .entry((*segment).to_string())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()))
            .as_object_mut()
            .expect("catalogue paths never cross a non-object");
    }
    cursor.insert((*last).to_string(), value);
}
