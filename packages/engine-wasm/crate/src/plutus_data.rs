use std::fmt::Write as _;

use serde::{Serialize, Deserialize};
use serde_json::Value;
use schemars::JsonSchema;
use pallas_primitives::PlutusData as PallasPlutusData;
use pallas_primitives::BigInt as PallasBigInt;

// Plutus Data nests as deep as whoever wrote it chose, bounded only by the size of the transaction
// carrying it, and the call stack of WebAssembly cannot grow. Building, cloning, writing as JSON
// and dropping a value therefore walk it with explicit stacks; it is written to JSON by
// `SerializablePlutusData::to_json`, exactly as the derived serializer would.
/// Serializable version of PlutusData that can be converted to/from JSON
#[derive(Deserialize, Debug, JsonSchema)]
#[serde(tag = "type")]
pub enum SerializablePlutusData {
    #[serde(rename = "Constr")]
    Constr {
        tag: u64,
        #[serde(rename = "any_constructor")]
        any_constructor: Option<u64>,
        fields: Vec<SerializablePlutusData>,
    },
    #[serde(rename = "Map")]
    Map {
        #[serde(rename = "key_value_pairs")]
        key_value_pairs: Vec<SerializableKeyValuePair>,
    },
    #[serde(rename = "BigInt")]
    BigInt(SerializableBigInt),
    #[serde(rename = "BoundedBytes")]
    BoundedBytes {
        value: String, // hex-encoded
    },
    #[serde(rename = "Array")]
    Array {
        values: Vec<SerializablePlutusData>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
pub struct SerializableKeyValuePair {
    pub key: SerializablePlutusData,
    pub value: SerializablePlutusData,
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
pub enum SerializableBigInt {
    #[serde(rename = "Int")]
    Int(String), // string representation of the integer
    #[serde(rename = "BigUInt")]
    BigUInt(String), // hex-encoded bytes
    #[serde(rename = "BigNInt")]
    BigNInt(String), // hex-encoded bytes
}

/// A container whose elements are being built, and how many of them to collect.
enum Build {
    Constr { tag: u64, any_constructor: Option<u64>, arity: usize },
    Map(usize),
    Array(usize),
}

impl Build {
    /// Gather the last elements built into the container they belong to.
    fn finish(self, done: &mut Vec<SerializablePlutusData>) {
        let container = match self {
            Build::Constr { tag, any_constructor, arity } => {
                let fields = done.split_off(done.len() - arity);
                SerializablePlutusData::Constr { tag, any_constructor, fields }
            }
            Build::Map(len) => {
                let mut flat = done.split_off(done.len() - 2 * len).into_iter();
                let mut key_value_pairs = Vec::with_capacity(len);
                while let (Some(key), Some(value)) = (flat.next(), flat.next()) {
                    key_value_pairs.push(SerializableKeyValuePair { key, value });
                }
                SerializablePlutusData::Map { key_value_pairs }
            }
            Build::Array(len) => {
                let values = done.split_off(done.len() - len);
                SerializablePlutusData::Array { values }
            }
        };
        done.push(container);
    }
}

impl SerializablePlutusData {
    /// Convert from Pallas PlutusData to our serializable version
    pub fn from_pallas(data: &PallasPlutusData) -> Self {
        enum Task<'d> {
            Visit(&'d PallasPlutusData),
            Build(Build),
        }

        let mut tasks = vec![Task::Visit(data)];
        let mut done: Vec<SerializablePlutusData> = Vec::new();

        while let Some(task) = tasks.pop() {
            match task {
                Task::Visit(data) => match data {
                    PallasPlutusData::Constr(constr) => {
                        tasks.push(Task::Build(Build::Constr {
                            tag: constr.tag,
                            any_constructor: constr.any_constructor,
                            arity: constr.fields.len(),
                        }));
                        tasks.extend(constr.fields.iter().rev().map(Task::Visit));
                    }
                    PallasPlutusData::Map(map) => {
                        tasks.push(Task::Build(Build::Map(map.len())));
                        for (key, value) in map.iter().rev() {
                            tasks.push(Task::Visit(value));
                            tasks.push(Task::Visit(key));
                        }
                    }
                    PallasPlutusData::BigInt(big_int) => {
                        done.push(SerializablePlutusData::BigInt(SerializableBigInt::from_pallas(big_int)))
                    }
                    PallasPlutusData::BoundedBytes(bytes) => done.push(SerializablePlutusData::BoundedBytes {
                        value: hex::encode(bytes.as_slice()),
                    }),
                    PallasPlutusData::Array(array) => {
                        tasks.push(Task::Build(Build::Array(array.len())));
                        tasks.extend(array.iter().rev().map(Task::Visit));
                    }
                },
                Task::Build(build) => build.finish(&mut done),
            }
        }

        done.pop().expect("the walk leaves the converted root")
    }

    /// Write this value as JSON, as the derived serializer of an internally tagged enum would.
    pub fn to_json(&self) -> String {
        enum Step<'d> {
            Data(&'d SerializablePlutusData),
            Raw(&'static str),
        }

        fn push_all<'d>(steps: &mut Vec<Step<'d>>, items: &'d [SerializablePlutusData]) {
            for (i, item) in items.iter().enumerate().rev() {
                steps.push(Step::Data(item));
                if i > 0 {
                    steps.push(Step::Raw(","));
                }
            }
        }

        let string = |s: &str| serde_json::to_string(s).unwrap_or_default();
        let mut out = String::new();
        let mut steps = vec![Step::Data(self)];

        while let Some(step) = steps.pop() {
            let data = match step {
                Step::Raw(raw) => {
                    out.push_str(raw);
                    continue;
                }
                Step::Data(data) => data,
            };

            match data {
                SerializablePlutusData::Constr { tag, any_constructor, fields } => {
                    let any_constructor = any_constructor.map_or_else(|| "null".to_string(), |index| index.to_string());
                    let _ = write!(out, r#"{{"type":"Constr","tag":{tag},"any_constructor":{any_constructor},"fields":["#);
                    steps.push(Step::Raw("]}"));
                    push_all(&mut steps, fields);
                }
                SerializablePlutusData::Map { key_value_pairs } => {
                    out.push_str(r#"{"type":"Map","key_value_pairs":["#);
                    steps.push(Step::Raw("]}"));
                    for (i, pair) in key_value_pairs.iter().enumerate().rev() {
                        steps.push(Step::Raw("}"));
                        steps.push(Step::Data(&pair.value));
                        steps.push(Step::Raw(r#","value":"#));
                        steps.push(Step::Data(&pair.key));
                        steps.push(Step::Raw(r#"{"key":"#));
                        if i > 0 {
                            steps.push(Step::Raw(","));
                        }
                    }
                }
                SerializablePlutusData::BigInt(big_int) => {
                    let (variant, value) = match big_int {
                        SerializableBigInt::Int(value) => ("Int", value),
                        SerializableBigInt::BigUInt(value) => ("BigUInt", value),
                        SerializableBigInt::BigNInt(value) => ("BigNInt", value),
                    };
                    let _ = write!(out, r#"{{"type":"BigInt","{variant}":{}}}"#, string(value));
                }
                SerializablePlutusData::BoundedBytes { value } => {
                    let _ = write!(out, r#"{{"type":"BoundedBytes","value":{}}}"#, string(value));
                }
                SerializablePlutusData::Array { values } => {
                    out.push_str(r#"{"type":"Array","values":["#);
                    steps.push(Step::Raw("]}"));
                    push_all(&mut steps, values);
                }
            }
        }

        out
    }

    /// Move the elements of this value onto `pending`, leaving it without any.
    fn detach_children(&mut self, pending: &mut Vec<SerializablePlutusData>) {
        match self {
            SerializablePlutusData::Constr { fields, .. } => pending.append(fields),
            SerializablePlutusData::Map { key_value_pairs } => {
                for pair in key_value_pairs.drain(..) {
                    let SerializableKeyValuePair { key, value } = pair;
                    pending.push(key);
                    pending.push(value);
                }
            }
            SerializablePlutusData::Array { values } => pending.append(values),
            SerializablePlutusData::BigInt(_) | SerializablePlutusData::BoundedBytes { .. } => {}
        }
    }

    /// Convert to JSON Value
    pub fn to_json_value(&self) -> Result<Value, serde_json::Error> {
        serde_json::from_str(&self.to_json())
    }

    /// Convert to JSON string
    pub fn to_json_string(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(&self.to_json_value()?)
    }

    /// Convert from JSON string
    pub fn from_json_string(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }
}

impl Serialize for SerializablePlutusData {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // Written without recursion and embedded as is: checking the JSON does not recurse either.
        let raw = serde_json::value::RawValue::from_string(self.to_json()).map_err(serde::ser::Error::custom)?;
        raw.serialize(serializer)
    }
}

impl Clone for SerializablePlutusData {
    fn clone(&self) -> Self {
        enum Task<'d> {
            Visit(&'d SerializablePlutusData),
            Build(Build),
        }

        let mut tasks = vec![Task::Visit(self)];
        let mut done: Vec<SerializablePlutusData> = Vec::new();

        while let Some(task) = tasks.pop() {
            match task {
                Task::Visit(data) => match data {
                    SerializablePlutusData::Constr { tag, any_constructor, fields } => {
                        tasks.push(Task::Build(Build::Constr {
                            tag: *tag,
                            any_constructor: *any_constructor,
                            arity: fields.len(),
                        }));
                        tasks.extend(fields.iter().rev().map(Task::Visit));
                    }
                    SerializablePlutusData::Map { key_value_pairs } => {
                        tasks.push(Task::Build(Build::Map(key_value_pairs.len())));
                        for pair in key_value_pairs.iter().rev() {
                            tasks.push(Task::Visit(&pair.value));
                            tasks.push(Task::Visit(&pair.key));
                        }
                    }
                    SerializablePlutusData::Array { values } => {
                        tasks.push(Task::Build(Build::Array(values.len())));
                        tasks.extend(values.iter().rev().map(Task::Visit));
                    }
                    SerializablePlutusData::BigInt(big_int) => done.push(SerializablePlutusData::BigInt(big_int.clone())),
                    SerializablePlutusData::BoundedBytes { value } => {
                        done.push(SerializablePlutusData::BoundedBytes { value: value.clone() })
                    }
                },
                Task::Build(build) => build.finish(&mut done),
            }
        }

        done.pop().expect("the walk leaves the cloned root")
    }
}

impl Drop for SerializablePlutusData {
    fn drop(&mut self) {
        let mut pending = Vec::new();
        self.detach_children(&mut pending);
        // Each value is emptied before it goes out of scope, so dropping it never reaches further.
        while let Some(mut data) = pending.pop() {
            data.detach_children(&mut pending);
        }
    }
}

impl SerializableBigInt {
    fn from_pallas(big_int: &PallasBigInt) -> Self {
        use num_bigint::{BigInt as NumBigInt, Sign as NumSign};
        match big_int {
            PallasBigInt::Int(int_val) => {
                SerializableBigInt::Int(int_val.to_string())
            },
            PallasBigInt::BigUInt(bytes) => {
                SerializableBigInt::BigUInt(NumBigInt::from_bytes_be(NumSign::Plus, bytes.as_slice()).to_string())
            },
            PallasBigInt::BigNInt(bytes) => {
                SerializableBigInt::BigNInt(NumBigInt::from_bytes_be(NumSign::Plus, bytes.as_slice()).to_string())
            },
        }
    }
}

/// Utility functions for working with PlutusData
impl SerializablePlutusData {
    /// Create a simple integer PlutusData
    pub fn integer(value: i64) -> Self {
        SerializablePlutusData::BigInt(SerializableBigInt::Int(value.to_string()))
    }

    /// Create a bytes PlutusData from hex string
    pub fn bytes_from_hex(hex: &str) -> Result<Self, hex::FromHexError> {
        // Validate hex string
        hex::decode(hex)?;
        Ok(SerializablePlutusData::BoundedBytes {
            value: hex.to_string(),
        })
    }

    /// Create a constructor PlutusData
    pub fn constructor(tag: u64, fields: Vec<SerializablePlutusData>) -> Self {
        SerializablePlutusData::Constr {
            tag,
            any_constructor: None,
            fields,
        }
    }

    /// Create an array PlutusData
    pub fn array(values: Vec<SerializablePlutusData>) -> Self {
        SerializablePlutusData::Array { values }
    }

    /// Create a map PlutusData
    pub fn map(pairs: Vec<(SerializablePlutusData, SerializablePlutusData)>) -> Self {
        SerializablePlutusData::Map {
            key_value_pairs: pairs.into_iter()
                .map(|(key, value)| SerializableKeyValuePair { key, value })
                .collect(),
        }
    }
}

// From trait implementation for easier conversion
impl From<PallasPlutusData> for SerializablePlutusData {
    fn from(data: PallasPlutusData) -> Self {
        Self::from_pallas(&data)
    }
}

impl From<&PallasPlutusData> for SerializablePlutusData {
    fn from(data: &PallasPlutusData) -> Self {
        Self::from_pallas(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_integer_serialization() {
        let data = SerializablePlutusData::integer(42);
        let json = data.to_json_string().unwrap();
        println!("Integer PlutusData JSON: {}", json);
        
        assert!(json.contains("\"type\": \"BigInt\""));
        assert!(json.contains("\"Int\": \"42\""));
    }

    #[test]
    fn test_bytes_serialization() {
        let data = SerializablePlutusData::bytes_from_hex("deadbeef").unwrap();
        let json = data.to_json_string().unwrap();
        println!("Bytes PlutusData JSON: {}", json);
        
        assert!(json.contains("\"type\": \"BoundedBytes\""));
        assert!(json.contains("\"value\": \"deadbeef\""));
    }

    #[test]
    fn test_constructor_serialization() {
        let fields = vec![
            SerializablePlutusData::integer(1),
            SerializablePlutusData::integer(2),
        ];
        let data = SerializablePlutusData::constructor(0, fields);
        let json = data.to_json_string().unwrap();
        println!("Constructor PlutusData JSON: {}", json);
        
        assert!(json.contains("\"type\": \"Constr\""));
        assert!(json.contains("\"tag\": 0"));
        assert!(json.contains("\"fields\""));
    }

    #[test]
    fn test_array_serialization() {
        let values = vec![
            SerializablePlutusData::integer(1),
            SerializablePlutusData::integer(2),
            SerializablePlutusData::integer(3),
        ];
        let data = SerializablePlutusData::array(values);
        let json = data.to_json_string().unwrap();
        println!("Array PlutusData JSON: {}", json);
        
        assert!(json.contains("\"type\": \"Array\""));
        assert!(json.contains("\"values\""));
    }

    #[test]
    fn test_map_serialization() {
        let pairs = vec![
            (SerializablePlutusData::integer(1), SerializablePlutusData::integer(10)),
            (SerializablePlutusData::integer(2), SerializablePlutusData::integer(20)),
        ];
        let data = SerializablePlutusData::map(pairs);
        let json = data.to_json_string().unwrap();
        println!("Map PlutusData JSON: {}", json);
        
        assert!(json.contains("\"type\": \"Map\""));
        assert!(json.contains("\"key_value_pairs\""));
    }

    #[test]
    fn test_nested_data_serialization() {
        // Create a complex nested structure
        let inner_array = SerializablePlutusData::array(vec![
            SerializablePlutusData::integer(1),
            SerializablePlutusData::integer(2),
        ]);
        
        let constructor = SerializablePlutusData::constructor(0, vec![
            inner_array,
            SerializablePlutusData::bytes_from_hex("cafe").unwrap(),
        ]);
        
        let json = constructor.to_json_string().unwrap();
        println!("Nested PlutusData JSON: {}", json);
        
        assert!(json.contains("\"type\": \"Constr\""));
        assert!(json.contains("\"type\": \"Array\""));
        assert!(json.contains("\"type\": \"BoundedBytes\""));
    }
} 