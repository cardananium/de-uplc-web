use serde::{Serialize, Deserialize};
use schemars::JsonSchema;
use crate::{
    serializer::EitherTermOrId,
    value::{SerializableValue, SerializableEnv},
    context::SerializableMachineContext,
    lazy_loading::{LazyLoadableValue, LazyLoadableTermOrId, LazyLoadableEnv, LazyLoadableContext},
};

#[derive(Serialize, Deserialize, Debug, JsonSchema)]
#[serde(tag = "machine_state_type")]
pub enum SerializableMachineState {
    #[serde(rename = "Return")]
    Return {
        context: SerializableMachineContext,
        value: SerializableValue,
    },
    #[serde(rename = "Compute")]
    Compute {
        context: SerializableMachineContext,
        env: SerializableEnv,
        term: EitherTermOrId,
    },
    #[serde(rename = "Done")]
    Done {
        term: EitherTermOrId,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(tag = "machine_state_type")]
pub enum SerializableMachineStateLazy {
    #[serde(rename = "Return")]
    Return {
        context: LazyLoadableContext,
        value: LazyLoadableValue,
    },
    #[serde(rename = "Compute")]
    Compute {
        context: LazyLoadableContext,
        env: LazyLoadableEnv,
        term: LazyLoadableTermOrId,
    },
    #[serde(rename = "Done")]
    Done {
        term: LazyLoadableTermOrId,
    },
}
