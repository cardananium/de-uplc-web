use std::collections::HashSet;

use uplc::machine::value::Value;
use serde::{Serialize, Deserialize};
use schemars::JsonSchema;
use crate::serializer::{SerializableConstant, EitherTermOrId};
use crate::lazy_loading::{LazyLoadableConstant, LazyLoadableTermOrId, LazyLoadableEnv, LazyLoadableValue, LazyLoadableBuiltinRuntime};
use crate::views::{self, Root};

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(tag = "value_type")]
pub enum SerializableValue {
    #[serde(rename = "Con")]
    Con {
        constant: SerializableConstant,
    },
    #[serde(rename = "Delay")]
    Delay {
        body: Box<EitherTermOrId>,
        env: SerializableEnv,
        term_id: i32,
    },
    #[serde(rename = "Lambda")]
    Lambda {
        #[serde(rename = "parameterName")]
        parameter_name: String,
        body: Box<EitherTermOrId>,
        env: SerializableEnv,
        term_id: i32,
    },
    #[serde(rename = "Builtin")]
    Builtin {
        fun: String,
        runtime: SerializableBuiltinRuntime,
        term_id: i32,
    },
    #[serde(rename = "Constr")]
    Constr {
        tag: usize,
        fields: Vec<SerializableValue>,
        term_id: i32,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
pub struct SerializableEnv {
    pub values: Vec<SerializableValue>,
}

/// Maximum number of elements to display when loading full object
/// to prevent performance issues with large environments
pub const MAX_FULL_OBJECT_ELEMENTS: usize = 10;

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
pub struct SerializableEnvLazy {
    pub values: Vec<LazyLoadableValue>,
    /// Number of elements displayed (M in "M of N")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub displayed_count: Option<usize>,
    /// Total number of elements in the environment (N in "M of N")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_count: Option<usize>,
    /// Message to display when elements are truncated
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncation_message: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(tag = "value_type")]
pub enum SerializableValueLazy {
    #[serde(rename = "Con")]
    Con {
        constant: LazyLoadableConstant,
    },
    #[serde(rename = "Delay")]
    Delay {
        body: LazyLoadableTermOrId,
        env: LazyLoadableEnv,
        term_id: i32,
    },
    #[serde(rename = "Lambda")]
    Lambda {
        #[serde(rename = "parameterName")]
        parameter_name: String,
        body: LazyLoadableTermOrId,
        env: LazyLoadableEnv,
        term_id: i32,
    },
    #[serde(rename = "Builtin")]
    Builtin {
        fun: String,
        runtime: LazyLoadableBuiltinRuntime,
        term_id: i32,
    },
    #[serde(rename = "Constr")]
    Constr {
        tag: usize,
        fields: Vec<LazyLoadableValue>,
        term_id: i32,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
pub struct SerializableBuiltinRuntimeLazy {
    args: Vec<LazyLoadableValue>,
    fun: String,
    forces: u32,
    arity: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
pub struct SerializableBuiltinRuntime {
    args: Vec<SerializableValue>,
    fun: String,
    forces: u32,
    arity: u32,
}

/// Convert a UPLC Value to JSON string
pub fn value_to_json(value: &Value) -> Result<String, serde_json::Error> {
    Ok(views::pretty(&views::plain(Root::Value(value), &HashSet::new())))
}

/// Convert a UPLC Value to JSON Value
pub fn value_to_json_value(value: &Value) -> Result<serde_json::Value, serde_json::Error> {
    serde_json::from_str(&views::plain(Root::Value(value), &HashSet::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::rc::Rc;
    use uplc::{
        ast::Constant,
        machine::value::Env,
    };

    fn env_to_json(env: &Env) -> String {
        views::plain(Root::Env(env), &HashSet::new())
    }

    #[test]
    fn test_con_value_serialization() {
        let constant = Rc::new(Constant::Integer(42.into()));
        let value = Value::Con(constant);
        let json = value_to_json(&value).unwrap();
        println!("Con Value JSON: {}", json);
        
        assert!(json.contains("\"value_type\": \"Con\""));
        assert!(json.contains("\"type\": \"Integer\""));
        assert!(json.contains("\"value\": \"42\""));
    }

    #[test]
    fn test_constr_value_serialization() {
        let field1 = Value::Con(Rc::new(Constant::Integer(1.into())));
        let field2 = Value::Con(Rc::new(Constant::String("test".to_string())));
        let value = Value::Constr {
            tag: 5,
            fields: vec![field1, field2],
            term_id: 123,
        };
        let json = value_to_json(&value).unwrap();
        println!("Constr Value JSON: {}", json);
        
        assert!(json.contains("\"value_type\": \"Constr\""));
        assert!(json.contains("\"tag\": 5"));
        assert!(json.contains("\"fields\""));
        assert!(json.contains("\"term_id\": 123"));
    }

    #[test]
    fn test_builtin_value_serialization() {
        use uplc::{builtins::DefaultFunction, machine::runtime::BuiltinRuntime};
        
        let value = Value::Builtin {
            fun: DefaultFunction::AddInteger,
        runtime: BuiltinRuntime::new(DefaultFunction::AddInteger),
            term_id: 456,
        };
        let json = value_to_json(&value).unwrap();
        println!("Builtin Value JSON: {}", json);
        
        assert!(json.contains("\"value_type\": \"Builtin\""));
        assert!(json.contains("\"fun\": \"AddInteger\""));
        assert!(json.contains("\"term_id\": 456"));
    }

    #[test]
    fn test_builtin_runtime_serialization() {
        use uplc::{builtins::DefaultFunction, machine::runtime::BuiltinRuntime};
        
        let runtime = BuiltinRuntime::new(DefaultFunction::AddInteger);
        let value = Value::Builtin {
            fun: DefaultFunction::AddInteger,
            runtime,
            term_id: 789,
        };
        let json = value_to_json(&value).unwrap();
        println!("Builtin Runtime JSON: {}", json);
        
        assert!(json.contains("\"value_type\": \"Builtin\""));
        assert!(json.contains("\"fun\": \"AddInteger\""));
        assert!(json.contains("\"forces\": 0"));
        assert!(json.contains("\"args\": []"));
    }

    #[test]
    fn test_empty_env() {
        let env: Env = Rc::new(vec![]);
        let json = env_to_json(&env);
        println!("Empty Env JSON: {}", json);
        
        assert!(json.contains("\"values\":[]"));
    }

    #[test]
    fn test_env_with_values() {
        let val1 = Value::Con(Rc::new(Constant::Integer(1.into())));
        let val2 = Value::Con(Rc::new(Constant::Bool(true)));
        let env: Env = Rc::new(vec![val1, val2]);
        let json = env_to_json(&env);
        println!("Env with Values JSON: {}", json);
        
        assert!(json.contains("\"values\""));
        assert!(json.contains("\"Integer\""));
        assert!(json.contains("\"Bool\""));
    }
}
