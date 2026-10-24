use std::collections::HashSet;

use crate::{
    SerializableValue, lazy_loading::{LazyLoadableEnv, LazyLoadableTermOrId, LazyLoadableValue}, serializer::EitherTermOrId, value::SerializableEnv,
    views::{self, Root},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(tag = "context_type")]
pub enum SerializableMachineContext {
    #[serde(rename = "FrameAwaitArg")]
    FrameAwaitArg { value: SerializableValue },
    #[serde(rename = "FrameAwaitFunTerm")]
    FrameAwaitFunTerm {
        env: SerializableEnv,
        term: EitherTermOrId,
    },
    #[serde(rename = "FrameAwaitFunValue")]
    FrameAwaitFunValue { value: SerializableValue },
    #[serde(rename = "FrameForce")]
    FrameForce,
    #[serde(rename = "FrameConstr")]
    FrameConstr {
        env: SerializableEnv,
        tag: usize,
        terms: Vec<EitherTermOrId>,
        values: Vec<SerializableValue>,
        term_id: i32,
    },
    #[serde(rename = "FrameCases")]
    FrameCases {
        env: SerializableEnv,
        terms: Vec<EitherTermOrId>,
    },
    #[serde(rename = "NoFrame")]
    NoFrame,
}

/// Convert a UPLC Context to JSON string
pub fn context_to_json(context: &uplc::machine::Context) -> Result<String, serde_json::Error> {
    Ok(views::pretty(&views::plain(Root::Frame(context), &HashSet::new())))
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(tag = "context_type")]
pub enum SerializableMachineContextLazy {
    #[serde(rename = "FrameAwaitArg")]
    FrameAwaitArg { value: LazyLoadableValue },
    #[serde(rename = "FrameAwaitFunTerm")]
    FrameAwaitFunTerm {
        env: LazyLoadableEnv,
        term: LazyLoadableTermOrId,
    },
    #[serde(rename = "FrameAwaitFunValue")]
    FrameAwaitFunValue { value: LazyLoadableValue },
    #[serde(rename = "FrameForce")]
    FrameForce,
    #[serde(rename = "FrameConstr")]
    FrameConstr {
        env: LazyLoadableEnv,
        tag: usize,
        terms: Vec<LazyLoadableTermOrId>,
        values: Vec<LazyLoadableValue>,
        term_id: i32,
    },
    #[serde(rename = "FrameCases")]
    FrameCases {
        env: LazyLoadableEnv,
        terms: Vec<LazyLoadableTermOrId>,
    },
    #[serde(rename = "NoFrame")]
    NoFrame,
}
