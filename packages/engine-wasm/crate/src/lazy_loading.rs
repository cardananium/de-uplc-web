use serde::{Deserialize, Serialize};
use schemars::JsonSchema;

// Define concrete lazy loadable types for JSON schemas
// These are designed to prevent the LazyLoadable2, LazyLoadable3, etc. naming issue

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(untagged)]
pub enum LazyLoadableValue {
    Loaded(crate::value::SerializableValueLazy),
    TypeOnly {
        #[serde(rename = "_type")]
        type_name: String,
        #[serde(rename = "_kind")]
        kind: String,
        #[serde(rename = "_length")]
        length: Option<usize>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(untagged)]
pub enum LazyLoadableConstant {
    Loaded(crate::serializer::SerializableConstantLazy),
    TypeOnly {
        #[serde(rename = "_type")]
        type_name: String,
        #[serde(rename = "_kind")]
        kind: String,
        #[serde(rename = "_length")]
        length: Option<usize>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(untagged)]
pub enum LazyLoadableTermOrId {
    Loaded(crate::serializer::EitherTermOrIdLazy),
    TypeOnly {
        #[serde(rename = "_type")]
        type_name: String,
        #[serde(rename = "_kind")]
        kind: String,
        #[serde(rename = "_length")]
        length: Option<usize>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(untagged)]
pub enum LazyLoadableEnv {
    Loaded(crate::value::SerializableEnvLazy),
    TypeOnly {
        #[serde(rename = "_type")]
        type_name: String,
        #[serde(rename = "_kind")]
        kind: String,
        #[serde(rename = "_length")]
        length: Option<usize>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(untagged)]
pub enum LazyLoadableContext {
    Loaded(crate::context::SerializableMachineContextLazy),
    TypeOnly {
        #[serde(rename = "_type")]
        type_name: String,
        #[serde(rename = "_kind")]
        kind: String,
        #[serde(rename = "_length")]
        length: Option<usize>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(untagged)]
pub enum LazyLoadableBuiltinRuntime {
    Loaded(crate::value::SerializableBuiltinRuntimeLazy),
    TypeOnly {
        #[serde(rename = "_type")]
        type_name: String,
        #[serde(rename = "_kind")]
        kind: String,
        #[serde(rename = "_length")]
        length: Option<usize>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(untagged)]
pub enum LazyLoadableTerm {
    Loaded(crate::serializer::SerializableTermLazy),
    TypeOnly {
        #[serde(rename = "_type")]
        type_name: String,
        #[serde(rename = "_kind")]
        kind: String,
        #[serde(rename = "_length")]
        length: Option<usize>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(untagged)]
pub enum LazyLoadableData {
    Loaded(crate::plutus_data::SerializablePlutusData),
    TypeOnly {
        #[serde(rename = "_type")]
        type_name: String,
        #[serde(rename = "_kind")]
        kind: String,
        #[serde(rename = "_length")]
        length: Option<usize>,
    },
}

/// Represents a segment in the path
#[derive(Debug, Clone, PartialEq)]
pub enum PathSegment {
    /// Named field in a struct/object
    Field(String),
    /// Index in an array/vector
    Index(usize),
}

/// Result of a navigation operation
#[derive(Debug)]
pub enum NavigationResult<T> {
    /// Successfully found the target element
    Found(T),
    /// Path is invalid for this structure
    InvalidPath(String),
    /// Navigation incomplete - need to go deeper
    Incomplete,
}
