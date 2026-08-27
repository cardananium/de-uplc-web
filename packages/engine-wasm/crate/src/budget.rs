use serde::{Serialize, Deserialize};
use schemars::JsonSchema;

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SerializableBudget {
    pub ex_units_spent: i64,
    /// The ExUnits DECLARED for this session (a tx redeemer's `ex_units`, or the `ex_units` of a
    /// parts deep-link), or `None` when nothing declared one. `None` means "there is no limit to
    /// measure against" — the host prints `—`. Never a stand-in default: a percentage of
    /// `ExBudget::default()` looks like a real budget while being unrelated to this script.
    pub ex_units_available: Option<i64>,
    pub memory_units_spent: i64,
    pub memory_units_available: Option<i64>,
}
