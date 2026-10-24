use serde::{Serialize, Deserialize};
use schemars::JsonSchema;
use crate::plutus_data::SerializablePlutusData;
use crate::lazy_loading::{LazyLoadableConstant, LazyLoadableTerm, LazyLoadableData};

// BLS serialization constants
const BLS12_381_G1_COMPRESSED_SIZE: usize = 48;
const BLS12_381_G2_COMPRESSED_SIZE: usize = 96;
const BLS12_381_G1_SERIALIZED_SIZE: usize = 96;
const BLS12_381_G2_SERIALIZED_SIZE: usize = 192;
const BLS12_381_FP12_SIZE: usize = 576;

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(tag = "type")]
pub enum EitherTermOrId {
    #[serde(rename = "Term")]
    Term {
        term: SerializableTerm,
    },
    #[serde(rename = "Id")]
    Id {
        id: i32,
    },
}

// The JSON of a term, as `views` writes it.
#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(tag = "term_type")]
pub enum SerializableTerm {
    #[serde(rename = "Var")]
    Var {
        id: i32,
        name: String,
    },
    #[serde(rename = "Delay")]
    Delay {
        id: i32,
        term: Box<SerializableTerm>,
    },
    #[serde(rename = "Lambda")]
    Lambda {
        id: i32,
        #[serde(rename = "parameterName")]
        parameter_name: String,
        body: Box<SerializableTerm>,
    },
    #[serde(rename = "Apply")]
    Apply {
        id: i32,
        function: Box<SerializableTerm>,
        argument: Box<SerializableTerm>,
    },
    #[serde(rename = "Constant")]
    Constant {
        id: i32,
        constant: SerializableConstant,
    },
    #[serde(rename = "Force")]
    Force {
        id: i32,
        term: Box<SerializableTerm>,
    },
    #[serde(rename = "Error")]
    Error {
        id: i32,
    },
    #[serde(rename = "Builtin")]
    Builtin {
        id: i32,
        fun: String,
    },
    #[serde(rename = "Constr")]
    Constr {
        id: i32,
        #[serde(rename = "constructorTag")]
        constructor_tag: usize,
        fields: Vec<SerializableTerm>,
    },
    #[serde(rename = "Case")]
    Case {
        id: i32,
        constr: Box<SerializableTerm>,
        branches: Vec<SerializableTerm>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(tag = "type")]
pub enum SerializableConstant {
    #[serde(rename = "Integer")]
    Integer { value: String },
    #[serde(rename = "ByteString")]
    ByteString { value: String },
    #[serde(rename = "String")]
    String { value: String },
    #[serde(rename = "Bool")]
    Bool { value: bool },
    #[serde(rename = "Unit")]
    Unit,
    #[serde(rename = "ProtoList")]
    ProtoList { 
        #[serde(rename = "elementType")]
        element_type: SerializableType, 
        values: Vec<SerializableConstant> 
    },
    /// An array (from protocol version 11, to every Plutus version), shaped as a list is.
    #[serde(rename = "ProtoArray")]
    ProtoArray {
        #[serde(rename = "elementType")]
        element_type: SerializableType,
        values: Vec<SerializableConstant>
    },
    #[serde(rename = "ProtoPair")]
    ProtoPair { 
        #[serde(rename = "first_type")]
        first_type: SerializableType, 
        #[serde(rename = "second_type")]
        second_type: SerializableType,
        #[serde(rename = "first_element")]
        first_element: Box<SerializableConstant>,
        #[serde(rename = "second_element")]
        second_element: Box<SerializableConstant>
    },
    #[serde(rename = "Data")]
    Data { 
        data: SerializablePlutusData
    },
    #[serde(rename = "Bls12_381G1Element")]
    Bls12_381G1Element { 
        #[serde(rename = "serialized")]
        serialized: String, // hex-encoded full point (96 bytes)
    },
    #[serde(rename = "Bls12_381G2Element")]
    Bls12_381G2Element { 
        #[serde(rename = "serialized")]
        serialized: String, // hex-encoded full point (192 bytes)
    },
    #[serde(rename = "Bls12_381MlResult")]
    Bls12_381MlResult { 
        #[serde(rename = "bytes")]
        bytes: String, // hex-encoded Fp12 element (576 bytes)
    },
    /// A ledger value (from protocol version 11, to every Plutus version): currency symbols
    /// ascending, each with its token names ascending; quantities are decimal strings (signed
    /// 128-bit).
    #[serde(rename = "Value")]
    Value { entries: Vec<SerializableValueAsset> },
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
pub struct SerializableValueAsset {
    /// Hex-encoded currency symbol (policy id; empty for ada).
    pub currency: String,
    pub tokens: Vec<SerializableValueToken>,
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
pub struct SerializableValueToken {
    /// Hex-encoded token name.
    pub name: String,
    pub quantity: String,
}

impl SerializableValueAsset {
    pub fn from_uplc_value(value: &uplc::ast::Value) -> Vec<Self> {
        value
            .clone()
            .into_entries()
            .into_iter()
            .map(|(currency, tokens)| SerializableValueAsset {
                currency: hex::encode(currency),
                tokens: tokens
                    .into_iter()
                    .map(|(name, quantity)| SerializableValueToken {
                        name: hex::encode(name),
                        quantity: quantity.to_string(),
                    })
                    .collect(),
            })
            .collect()
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(tag = "type")]
pub enum SerializableType {
    #[serde(rename = "Bool")]
    Bool,
    #[serde(rename = "Integer")]
    Integer,
    #[serde(rename = "String")]
    String,
    #[serde(rename = "ByteString")]
    ByteString,
    #[serde(rename = "Unit")]
    Unit,
    #[serde(rename = "List")]
    List { 
        #[serde(rename = "elementType")]
        element_type: Box<SerializableType> 
    },
    #[serde(rename = "Array")]
    Array {
        #[serde(rename = "elementType")]
        element_type: Box<SerializableType>
    },
    #[serde(rename = "Pair")]
    Pair { 
        #[serde(rename = "first_type")]
        first_type: Box<SerializableType>, 
        #[serde(rename = "second_type")]
        second_type: Box<SerializableType> 
    },
    #[serde(rename = "Data")]
    Data,
    #[serde(rename = "Bls12_381G1Element")]
    Bls12_381G1Element,
    #[serde(rename = "Bls12_381G2Element")]
    Bls12_381G2Element,
    #[serde(rename = "Bls12_381MlResult")]
    Bls12_381MlResult,
    #[serde(rename = "Value")]
    Value,
}

// === COMPRESSED SERIALIZATION FUNCTIONS (for optional use) ===

/// Serialize BLS G1 element to compressed hex string (48 bytes)
pub fn serialize_bls_g1_element_compressed(element: &blst::blst_p1) -> String {
    unsafe {
        let mut buffer = [0u8; BLS12_381_G1_COMPRESSED_SIZE];
        blst::blst_p1_compress(buffer.as_mut_ptr(), element);
        hex::encode(buffer)
    }
}

/// Serialize BLS G2 element to compressed hex string (96 bytes)
pub fn serialize_bls_g2_element_compressed(element: &blst::blst_p2) -> String {
    unsafe {
        let mut buffer = [0u8; BLS12_381_G2_COMPRESSED_SIZE];
        blst::blst_p2_compress(buffer.as_mut_ptr(), element);
        hex::encode(buffer)
    }
}

// === FULL SERIALIZATION FUNCTIONS (used by default) ===

/// Serialize BLS G1 element to full hex string (96 bytes)
pub(crate) fn serialize_bls_g1_element_full(element: &blst::blst_p1) -> String {
    unsafe {
        let mut buffer = [0u8; BLS12_381_G1_SERIALIZED_SIZE];
        blst::blst_p1_serialize(buffer.as_mut_ptr(), element);
        hex::encode(buffer)
    }
}

/// Serialize BLS G2 element to full hex string (192 bytes)
pub(crate) fn serialize_bls_g2_element_full(element: &blst::blst_p2) -> String {
    unsafe {
        let mut buffer = [0u8; BLS12_381_G2_SERIALIZED_SIZE];
        blst::blst_p2_serialize(buffer.as_mut_ptr(), element);
        hex::encode(buffer)
    }
}

/// Serialize BLS Fp12 element to hex string (576 bytes)
pub(crate) fn serialize_bls_fp12_element(element: &blst::blst_fp12) -> String {
    unsafe {
        let mut buffer = [0u8; BLS12_381_FP12_SIZE];
        blst::blst_bendian_from_fp12(buffer.as_mut_ptr(), element);
        hex::encode(buffer)
    }
}

// Lazy loading versions

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(tag = "type")]
pub enum EitherTermOrIdLazy {
    #[serde(rename = "Term")]
    Term {
        term: LazyLoadableTerm,
    },
    #[serde(rename = "Id")]
    Id {
        id: i32,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(tag = "term_type")]
pub enum SerializableTermLazy {
    #[serde(rename = "Var")]
    Var {
        id: i32,
        name: String,
    },
    #[serde(rename = "Delay")]
    Delay {
        id: i32,
        term: Box<LazyLoadableTerm>,
    },
    #[serde(rename = "Lambda")]
    Lambda {
        id: i32,
        #[serde(rename = "parameterName")]
        parameter_name: String,
        body: Box<LazyLoadableTerm>,
    },
    #[serde(rename = "Apply")]
    Apply {
        id: i32,
        function: Box<LazyLoadableTerm>,
        argument: Box<LazyLoadableTerm>,
    },
    #[serde(rename = "Constant")]
    Constant {
        id: i32,
        constant: LazyLoadableConstant,
    },
    #[serde(rename = "Force")]
    Force {
        id: i32,
        term: Box<LazyLoadableTerm>,
    },
    #[serde(rename = "Error")]
    Error {
        id: i32,
    },
    #[serde(rename = "Builtin")]
    Builtin {
        id: i32,
        fun: String,
    },
    #[serde(rename = "Constr")]
    Constr {
        id: i32,
        #[serde(rename = "constructorTag")]
        constructor_tag: usize,
        fields: Vec<LazyLoadableTerm>,
    },
    #[serde(rename = "Case")]
    Case {
        id: i32,
        constr: Box<LazyLoadableTerm>,
        branches: Vec<LazyLoadableTerm>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, JsonSchema)]
#[serde(tag = "type")]
pub enum SerializableConstantLazy {
    #[serde(rename = "Integer")]
    Integer { value: String },
    #[serde(rename = "ByteString")]
    ByteString { value: String },
    #[serde(rename = "String")]
    String { value: String },
    #[serde(rename = "Bool")]
    Bool { value: bool },
    #[serde(rename = "Unit")]
    Unit,
    #[serde(rename = "ProtoList")]
    ProtoList { 
        #[serde(rename = "elementType")]
        element_type: SerializableType, 
        values: Vec<LazyLoadableConstant> 
    },
    #[serde(rename = "ProtoArray")]
    ProtoArray {
        #[serde(rename = "elementType")]
        element_type: SerializableType,
        values: Vec<LazyLoadableConstant>
    },
    #[serde(rename = "ProtoPair")]
    ProtoPair { 
        #[serde(rename = "first_type")]
        first_type: SerializableType, 
        #[serde(rename = "second_type")]
        second_type: SerializableType,
        #[serde(rename = "first_element")]
        first_element: Box<LazyLoadableConstant>,
        #[serde(rename = "second_element")]
        second_element: Box<LazyLoadableConstant>
    },
    #[serde(rename = "Data")]
    Data { 
        data: LazyLoadableData
    },
    #[serde(rename = "Bls12_381G1Element")]
    Bls12_381G1Element { 
        #[serde(rename = "serialized")]
        serialized: String,
    },
    #[serde(rename = "Bls12_381G2Element")]
    Bls12_381G2Element { 
        #[serde(rename = "serialized")]
        serialized: String,
    },
    #[serde(rename = "Bls12_381MlResult")]
    Bls12_381MlResult { 
        #[serde(rename = "bytes")]
        bytes: String,
    },
    #[serde(rename = "Value")]
    Value { entries: Vec<SerializableValueAsset> },
}
