//! The views of a run — its terms, constants, types, values, environments, frames and state —
//! written as JSON.
//!
//! Any of these can nest as deep as a script's size allows: a 17 KB script holds some 35 000
//! levels of terms, a closure carries the environment it was made in, which carries closures of
//! its own, and a constant's type nests as deep as its author chose. So one writer walks them all
//! with an explicit stack of tasks: nothing here recurses, builds a tree it would have to drop, or
//! goes through `serde_json::Value`, whose parser gives up past 128 levels.
//!
//! The JSON is the shape the `Serializable*` types declare — their serde attributes are the
//! contract the schemas and the TypeScript types are generated from; this module writes it.
//! There are three levels of detail:
//!
//! - `Plain`: the eager views (`get_machine_state` …): every value in full, environments included.
//! - `Shallow`: a lazy view one level deep: an environment's values, a list constant's items, a
//!   constructor value's fields and a builtin's arguments are placeholders (`{_type, _kind,
//!   _length}`) the UI loads on demand by their `_path`.
//! - `Full`: a lazy view asked for the whole object: everything loaded, an environment's values
//!   beyond `MAX_FULL_OBJECT_ELEMENTS` left out (and said so).
//!
//! A term is always written whole, constants inside it at the level of detail of the view, and a
//! term of the program is referenced by its id wherever a value or a frame holds one.

use std::collections::HashSet;
use std::fmt::Write as _;

use uplc::{
    ast::{Constant, NamedDeBruijn, Term, Type},
    machine::{
        runtime::BuiltinRuntime,
        value::{Env, Value},
        Context, MachineState,
    },
};

use crate::lazy_loading::{NavigationResult, PathSegment};
use crate::plutus_data::SerializablePlutusData;
use crate::serializer::{
    serialize_bls_fp12_element, serialize_bls_g1_element_compressed, serialize_bls_g1_element_full,
    serialize_bls_g2_element_compressed, serialize_bls_g2_element_full, SerializableValueAsset,
};
use crate::value::MAX_FULL_OBJECT_ELEMENTS;

/// How much of a node a view writes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Detail {
    Plain,
    Shallow,
    Full,
}

impl Detail {
    /// The lazy level of detail a `return_full_object` flag asks for.
    pub fn lazy(return_full_object: bool) -> Self {
        if return_full_object {
            Detail::Full
        } else {
            Detail::Shallow
        }
    }
}

/// Placeholders deeper than this, counted in path segments, carry no `_path` handle: the UI then
/// builds the path itself, as it does for any placeholder without one. Written, a handle repeats
/// the whole path to its node, so handles on every placeholder of a deep tree would grow with the
/// square of its depth.
const HANDLE_DEPTH: usize = 256;

/// No pointer: the node is not part of a lazy view, so nothing below it needs a handle.
const NO_POINTER: u32 = u32::MAX;

#[derive(Clone, Copy)]
enum Segment {
    Root,
    Field(&'static str),
    Index(usize),
}

/// How a node is named: as the view goes, or with every program term written in full (a builtin's
/// arguments in the eager view, as they have always been written).
#[derive(Clone, Copy)]
struct How {
    detail: Detail,
    inline: bool,
}

enum Task<'a> {
    Text(&'static str),
    Owned(String),
    Term(&'a Term<NamedDeBruijn>, How, u32),
    TermOrId(&'a Term<NamedDeBruijn>, How, u32),
    Constant(&'a Constant, How, u32),
    Type(&'a Type),
    Value(&'a Value, How, u32),
    Env(&'a Env, How, u32),
    Runtime(&'a BuiltinRuntime, How, u32),
    Frame(&'a Context, How, u32),
    /// `,"term_id":N}` closing a value or a constructor frame, written once what comes before it
    /// is.
    Tail(&'static str, isize),
}

/// What a navigation lands on, to be written as the view's root.
pub enum Root<'a> {
    Term(&'a Term<NamedDeBruijn>),
    /// A constant inside a term, written back inside the `Constant` term that holds it.
    TermConstant(i32, &'a Constant),
    Constant(&'a Constant),
    Value(&'a Value),
    Env(&'a Env),
    Frame(&'a Context),
    Frames(Vec<&'a Context>),
    State(&'a MachineState),
}

pub struct Writer<'n> {
    /// The ids of the program's own terms: a value or a frame holding one of them names it by id.
    program: &'n HashSet<i32>,
    /// The path the view was asked for: every handle starts with it.
    base: &'n [String],
    out: String,
    /// The JSON pointer of every node of a lazy view written so far: parent, segment, depth.
    pointers: Vec<(u32, Segment, u32)>,
}

impl<'n> Writer<'n> {
    pub fn new(program: &'n HashSet<i32>, base: &'n [String]) -> Self {
        Writer {
            program,
            base,
            out: String::new(),
            pointers: Vec::new(),
        }
    }

    /// Write `root` at `detail`, and hand back the JSON.
    pub fn write(mut self, root: Root<'_>, detail: Detail) -> String {
        let how = How { detail, inline: false };
        let ptr = self.root_pointer(detail);
        let mut tasks: Vec<Task<'_>> = Vec::new();

        match root {
            Root::Term(term) => tasks.push(Task::Term(term, how, ptr)),
            Root::TermConstant(id, constant) => {
                let _ = write!(self.out, r#"{{"term_type":"Constant","id":{id},"constant":"#);
                tasks.push(Task::Text("}"));
                let child = self.child(ptr, Segment::Field("constant"));
                tasks.push(Task::Constant(constant, how, child));
            }
            Root::Constant(constant) => tasks.push(Task::Constant(constant, how, ptr)),
            Root::Value(value) => tasks.push(Task::Value(value, how, ptr)),
            Root::Env(env) => tasks.push(Task::Env(env, how, ptr)),
            Root::Frame(frame) => tasks.push(Task::Frame(frame, how, ptr)),
            Root::Frames(frames) => {
                self.out.push('[');
                tasks.push(Task::Text("]"));
                for (i, frame) in frames.iter().enumerate().rev() {
                    let child = self.child(ptr, Segment::Index(i));
                    tasks.push(Task::Frame(frame, how, child));
                    if i > 0 {
                        tasks.push(Task::Text(","));
                    }
                }
            }
            Root::State(state) => self.state(state, how, ptr, &mut tasks),
        }

        while let Some(task) = tasks.pop() {
            match task {
                Task::Text(text) => self.out.push_str(text),
                Task::Owned(text) => self.out.push_str(&text),
                Task::Term(term, how, ptr) => self.term(term, how, ptr, &mut tasks),
                Task::TermOrId(term, how, ptr) => self.term_or_id(term, how, ptr, &mut tasks),
                Task::Constant(constant, how, ptr) => self.constant(constant, how, ptr, &mut tasks),
                Task::Type(typ) => self.typ(typ, &mut tasks),
                Task::Value(value, how, ptr) => self.value(value, how, ptr, &mut tasks),
                Task::Env(env, how, ptr) => self.env(env, how, ptr, &mut tasks),
                Task::Runtime(runtime, how, ptr) => self.runtime(runtime, how, ptr, &mut tasks),
                Task::Frame(frame, how, ptr) => self.frame(frame, how, ptr, &mut tasks),
                Task::Tail(close, id) => {
                    let _ = write!(self.out, r#"{close},"term_id":{}}}"#, id as i32);
                }
            }
        }

        self.out
    }

    /// The id a program term is referenced by, unless the view writes every term in full.
    fn reference(&self, term: &Term<NamedDeBruijn>, how: How) -> Option<i32> {
        let id = term.uniq_id() as i32;
        (!how.inline && self.program.contains(&id)).then_some(id)
    }

    fn root_pointer(&mut self, detail: Detail) -> u32 {
        if detail == Detail::Plain {
            return NO_POINTER;
        }
        self.pointers.push((NO_POINTER, Segment::Root, 0));
        (self.pointers.len() - 1) as u32
    }

    fn child(&mut self, parent: u32, segment: Segment) -> u32 {
        if parent == NO_POINTER {
            return NO_POINTER;
        }
        let depth = self.pointers[parent as usize].2 + 1;
        self.pointers.push((parent, segment, depth));
        (self.pointers.len() - 1) as u32
    }

    fn child_at(&mut self, parent: u32, field: &'static str, index: usize) -> u32 {
        let list = self.child(parent, Segment::Field(field));
        self.child(list, Segment::Index(index))
    }

    /// `{"_type":…,"_kind":…,"_length":…}`, with the `_path` handle the UI loads the node by.
    fn placeholder(&self, out: &mut String, (type_name, kind, length): (&str, &str, Option<usize>), ptr: u32) {
        out.push_str(r#"{"_type":"#);
        push_str(out, type_name);
        out.push_str(r#","_kind":"#);
        push_str(out, kind);
        match length {
            Some(length) => {
                let _ = write!(out, r#","_length":{length}"#);
            }
            None => out.push_str(r#","_length":null"#),
        }

        if ptr != NO_POINTER {
            let depth = self.pointers[ptr as usize].2 as usize;
            if self.base.len() + depth <= HANDLE_DEPTH {
                let mut segments = Vec::with_capacity(depth);
                let mut at = ptr;
                while at != NO_POINTER {
                    let (parent, segment, _) = self.pointers[at as usize];
                    segments.push(segment);
                    at = parent;
                }
                out.push_str(r#","_path":["#);
                let mut first = true;
                for part in self.base.iter() {
                    if !first {
                        out.push(',');
                    }
                    first = false;
                    push_str(out, part);
                }
                for segment in segments.iter().rev() {
                    let text = match segment {
                        Segment::Root => continue,
                        Segment::Field(field) => field.to_string(),
                        Segment::Index(index) => index.to_string(),
                    };
                    if !first {
                        out.push(',');
                    }
                    first = false;
                    push_str(out, &text);
                }
                out.push(']');
            }
        }

        out.push('}');
    }

    /// A placeholder written straight into the view.
    fn push_placeholder(&mut self, parts: (&str, &str, Option<usize>), ptr: u32) {
        let mut out = std::mem::take(&mut self.out);
        self.placeholder(&mut out, parts, ptr);
        self.out = out;
    }

    fn term<'a>(&mut self, term: &'a Term<NamedDeBruijn>, how: How, ptr: u32, tasks: &mut Vec<Task<'a>>) {
        let id = term.uniq_id() as i32;
        match term {
            Term::Var { name, .. } => {
                let _ = write!(self.out, r#"{{"term_type":"Var","id":{id},"name":"#);
                push_str(&mut self.out, &name.text);
                self.out.push('}');
            }
            Term::Error { .. } => {
                let _ = write!(self.out, r#"{{"term_type":"Error","id":{id}}}"#);
            }
            Term::Builtin { fun, .. } => {
                let _ = write!(self.out, r#"{{"term_type":"Builtin","id":{id},"fun":"#);
                push_str(&mut self.out, &format!("{fun:?}"));
                self.out.push('}');
            }
            Term::Constant { value, .. } => {
                let _ = write!(self.out, r#"{{"term_type":"Constant","id":{id},"constant":"#);
                tasks.push(Task::Text("}"));
                let child = self.child(ptr, Segment::Field("constant"));
                tasks.push(Task::Constant(value, how, child));
            }
            Term::Delay { body, .. } => {
                let _ = write!(self.out, r#"{{"term_type":"Delay","id":{id},"term":"#);
                tasks.push(Task::Text("}"));
                let child = self.child(ptr, Segment::Field("term"));
                tasks.push(Task::Term(body, how, child));
            }
            Term::Force { body, .. } => {
                let _ = write!(self.out, r#"{{"term_type":"Force","id":{id},"term":"#);
                tasks.push(Task::Text("}"));
                let child = self.child(ptr, Segment::Field("term"));
                tasks.push(Task::Term(body, how, child));
            }
            Term::Lambda { parameter_name, body, .. } => {
                let _ = write!(self.out, r#"{{"term_type":"Lambda","id":{id},"parameterName":"#);
                push_str(&mut self.out, &parameter_name.text);
                self.out.push_str(r#","body":"#);
                tasks.push(Task::Text("}"));
                let child = self.child(ptr, Segment::Field("body"));
                tasks.push(Task::Term(body, how, child));
            }
            Term::Apply { function, argument, .. } => {
                let _ = write!(self.out, r#"{{"term_type":"Apply","id":{id},"function":"#);
                tasks.push(Task::Text("}"));
                let child = self.child(ptr, Segment::Field("argument"));
                tasks.push(Task::Term(argument, how, child));
                tasks.push(Task::Text(r#","argument":"#));
                let child = self.child(ptr, Segment::Field("function"));
                tasks.push(Task::Term(function, how, child));
            }
            Term::Constr { tag, fields, .. } => {
                let _ = write!(self.out, r#"{{"term_type":"Constr","id":{id},"constructorTag":{tag},"fields":["#);
                tasks.push(Task::Text("]}"));
                for (i, field) in fields.iter().enumerate().rev() {
                    let child = self.child_at(ptr, "fields", i);
                    tasks.push(Task::Term(field, how, child));
                    if i > 0 {
                        tasks.push(Task::Text(","));
                    }
                }
            }
            Term::Case { constr, branches, .. } => {
                let _ = write!(self.out, r#"{{"term_type":"Case","id":{id},"constr":"#);
                tasks.push(Task::Text("]}"));
                for (i, branch) in branches.iter().enumerate().rev() {
                    let child = self.child_at(ptr, "branches", i);
                    tasks.push(Task::Term(branch, how, child));
                    if i > 0 {
                        tasks.push(Task::Text(","));
                    }
                }
                tasks.push(Task::Text(r#","branches":["#));
                let child = self.child(ptr, Segment::Field("constr"));
                tasks.push(Task::Term(constr, how, child));
            }
        }
    }

    fn term_or_id<'a>(&mut self, term: &'a Term<NamedDeBruijn>, how: How, ptr: u32, tasks: &mut Vec<Task<'a>>) {
        match self.reference(term, how) {
            Some(id) => {
                let _ = write!(self.out, r#"{{"type":"Id","id":{id}}}"#);
            }
            None => {
                self.out.push_str(r#"{"type":"Term","term":"#);
                tasks.push(Task::Text("}"));
                let child = self.child(ptr, Segment::Field("term"));
                tasks.push(Task::Term(term, how, child));
            }
        }
    }

    fn constant<'a>(&mut self, constant: &'a Constant, how: How, ptr: u32, tasks: &mut Vec<Task<'a>>) {
        match constant {
            Constant::Integer(i) => {
                let _ = write!(self.out, r#"{{"type":"Integer","value":"{i}"}}"#);
            }
            Constant::ByteString(bytes) => {
                let _ = write!(self.out, r#"{{"type":"ByteString","value":"{}"}}"#, hex::encode(bytes));
            }
            Constant::String(s) => {
                self.out.push_str(r#"{"type":"String","value":"#);
                push_str(&mut self.out, s);
                self.out.push('}');
            }
            Constant::Bool(b) => {
                let _ = write!(self.out, r#"{{"type":"Bool","value":{b}}}"#);
            }
            Constant::Unit => self.out.push_str(r#"{"type":"Unit"}"#),
            Constant::ProtoList(typ, items) | Constant::ProtoArray(typ, items) => {
                let tag = if matches!(constant, Constant::ProtoArray(..)) { "ProtoArray" } else { "ProtoList" };
                let _ = write!(self.out, r#"{{"type":"{tag}","elementType":"#);
                if how.detail == Detail::Shallow {
                    let mut tail = String::from(r#","values":["#);
                    for (i, item) in items.iter().enumerate() {
                        if i > 0 {
                            tail.push(',');
                        }
                        let child = self.child_at(ptr, "values", i);
                        self.placeholder(&mut tail, constant_kind(item).as_parts(), child);
                    }
                    tail.push_str("]}");
                    tasks.push(Task::Owned(tail));
                } else {
                    tasks.push(Task::Text("]}"));
                    for (i, item) in items.iter().enumerate().rev() {
                        let child = self.child_at(ptr, "values", i);
                        tasks.push(Task::Constant(item, how, child));
                        if i > 0 {
                            tasks.push(Task::Text(","));
                        }
                    }
                    tasks.push(Task::Text(r#","values":["#));
                }
                tasks.push(Task::Type(typ));
            }
            Constant::ProtoPair(first_type, second_type, first, second) => {
                self.out.push_str(r#"{"type":"ProtoPair","first_type":"#);
                tasks.push(Task::Text("}"));
                let child = self.child(ptr, Segment::Field("second_element"));
                tasks.push(Task::Constant(second, how, child));
                tasks.push(Task::Text(r#","second_element":"#));
                let child = self.child(ptr, Segment::Field("first_element"));
                tasks.push(Task::Constant(first, how, child));
                tasks.push(Task::Text(r#","first_element":"#));
                tasks.push(Task::Type(second_type));
                tasks.push(Task::Text(r#","second_type":"#));
                tasks.push(Task::Type(first_type));
            }
            Constant::Data(data) => {
                self.out.push_str(r#"{"type":"Data","data":"#);
                self.out.push_str(&SerializablePlutusData::from_pallas(data).to_json());
                self.out.push('}');
            }
            Constant::Bls12_381G1Element(element) => {
                let serialized = match how.detail {
                    Detail::Plain => serialize_bls_g1_element_full(element),
                    Detail::Shallow | Detail::Full => serialize_bls_g1_element_compressed(element),
                };
                let _ = write!(self.out, r#"{{"type":"Bls12_381G1Element","serialized":"{serialized}"}}"#);
            }
            Constant::Bls12_381G2Element(element) => {
                let serialized = match how.detail {
                    Detail::Plain => serialize_bls_g2_element_full(element),
                    Detail::Shallow | Detail::Full => serialize_bls_g2_element_compressed(element),
                };
                let _ = write!(self.out, r#"{{"type":"Bls12_381G2Element","serialized":"{serialized}"}}"#);
            }
            Constant::Bls12_381MlResult(result) => {
                let bytes = serialize_bls_fp12_element(result);
                let _ = write!(self.out, r#"{{"type":"Bls12_381MlResult","bytes":"{bytes}"}}"#);
            }
            Constant::Value(value) => {
                let entries = serde_json::to_string(&SerializableValueAsset::from_uplc_value(value))
                    .unwrap_or_else(|_| "[]".to_string());
                let _ = write!(self.out, r#"{{"type":"Value","entries":{entries}}}"#);
            }
        }
    }

    fn typ<'a>(&mut self, typ: &'a Type, tasks: &mut Vec<Task<'a>>) {
        let leaf = match typ {
            Type::Bool => "Bool",
            Type::Integer => "Integer",
            Type::String => "String",
            Type::ByteString => "ByteString",
            Type::Unit => "Unit",
            Type::Data => "Data",
            Type::Bls12_381G1Element => "Bls12_381G1Element",
            Type::Bls12_381G2Element => "Bls12_381G2Element",
            Type::Bls12_381MlResult => "Bls12_381MlResult",
            Type::Value => "Value",
            Type::List(element) => {
                self.out.push_str(r#"{"type":"List","elementType":"#);
                tasks.push(Task::Text("}"));
                tasks.push(Task::Type(element));
                return;
            }
            Type::Array(element) => {
                self.out.push_str(r#"{"type":"Array","elementType":"#);
                tasks.push(Task::Text("}"));
                tasks.push(Task::Type(element));
                return;
            }
            Type::Pair(first, second) => {
                self.out.push_str(r#"{"type":"Pair","first_type":"#);
                tasks.push(Task::Text("}"));
                tasks.push(Task::Type(second));
                tasks.push(Task::Text(r#","second_type":"#));
                tasks.push(Task::Type(first));
                return;
            }
        };
        let _ = write!(self.out, r#"{{"type":"{leaf}"}}"#);
    }

    fn value<'a>(&mut self, value: &'a Value, how: How, ptr: u32, tasks: &mut Vec<Task<'a>>) {
        match value {
            Value::Con(constant) => {
                self.out.push_str(r#"{"value_type":"Con","constant":"#);
                tasks.push(Task::Text("}"));
                let child = self.child(ptr, Segment::Field("constant"));
                tasks.push(Task::Constant(constant, how, child));
            }
            Value::Delay { body, env, term_id } => {
                self.out.push_str(r#"{"value_type":"Delay","body":"#);
                self.closure(*term_id, body, env, how, ptr, tasks);
            }
            Value::Lambda { parameter_name, body, env, term_id } => {
                self.out.push_str(r#"{"value_type":"Lambda","parameterName":"#);
                push_str(&mut self.out, &parameter_name.text);
                self.out.push_str(r#","body":"#);
                self.closure(*term_id, body, env, how, ptr, tasks);
            }
            Value::Builtin { fun, runtime, term_id } => {
                self.out.push_str(r#"{"value_type":"Builtin","fun":"#);
                push_str(&mut self.out, &format!("{fun:?}"));
                self.out.push_str(r#","runtime":"#);
                tasks.push(Task::Tail("", *term_id));
                let child = self.child(ptr, Segment::Field("runtime"));
                tasks.push(Task::Runtime(runtime, how, child));
            }
            Value::Constr { tag, fields, term_id } => {
                let _ = write!(self.out, r#"{{"value_type":"Constr","tag":{tag},"fields":["#);
                if how.detail == Detail::Shallow {
                    for (i, field) in fields.iter().enumerate() {
                        if i > 0 {
                            self.out.push(',');
                        }
                        let child = self.child_at(ptr, "fields", i);
                        self.push_placeholder(value_kind(field).as_parts(), child);
                    }
                    tasks.push(Task::Tail("]", *term_id));
                } else {
                    tasks.push(Task::Tail("]", *term_id));
                    for (i, field) in fields.iter().enumerate().rev() {
                        let child = self.child_at(ptr, "fields", i);
                        tasks.push(Task::Value(field, how, child));
                        if i > 0 {
                            tasks.push(Task::Text(","));
                        }
                    }
                }
            }
        }
    }

    /// The body and the environment of a delayed or a lambda value, and the id it closes with.
    fn closure<'a>(
        &mut self,
        term_id: isize,
        body: &'a Term<NamedDeBruijn>,
        env: &'a Env,
        how: How,
        ptr: u32,
        tasks: &mut Vec<Task<'a>>,
    ) {
        tasks.push(Task::Tail("", term_id));
        let child = self.child(ptr, Segment::Field("env"));
        tasks.push(Task::Env(env, how, child));
        tasks.push(Task::Text(r#","env":"#));
        let child = self.child(ptr, Segment::Field("body"));
        tasks.push(Task::TermOrId(body, how, child));
    }

    /// An environment's values, outermost binder first, as the machine keeps them.
    fn env<'a>(&mut self, env: &'a Env, how: How, ptr: u32, tasks: &mut Vec<Task<'a>>) {
        self.out.push_str(r#"{"values":["#);
        match how.detail {
            Detail::Shallow => {
                for (i, value) in env.iter().enumerate() {
                    if i > 0 {
                        self.out.push(',');
                    }
                    let child = self.child_at(ptr, "values", i);
                    self.push_placeholder(value_kind(value).as_parts(), child);
                }
                self.out.push_str("]}");
            }
            Detail::Plain | Detail::Full => {
                let total = env.len();
                let shown = if how.detail == Detail::Full { total.min(MAX_FULL_OBJECT_ELEMENTS) } else { total };
                if shown < total {
                    let mut tail = format!(r#"],"displayed_count":{shown},"total_count":{total},"truncation_message":"#);
                    push_str(
                        &mut tail,
                        &format!(
                            "Showing {shown} of {total} elements. Use the left panel tree view to explore specific elements."
                        ),
                    );
                    tail.push('}');
                    tasks.push(Task::Owned(tail));
                } else {
                    tasks.push(Task::Text("]}"));
                }
                for (i, value) in env.iter().enumerate().take(shown).rev() {
                    let child = self.child_at(ptr, "values", i);
                    tasks.push(Task::Value(value, how, child));
                    if i > 0 {
                        tasks.push(Task::Text(","));
                    }
                }
            }
        }
    }

    fn runtime<'a>(&mut self, runtime: &'a BuiltinRuntime, how: How, ptr: u32, tasks: &mut Vec<Task<'a>>) {
        // The eager view names the builtin capitalised; the lazy one as the term viewer does.
        let fun = match how.detail {
            Detail::Plain => {
                let mut name = runtime.fun.to_string();
                if let Some(first) = name.chars().next() {
                    name.replace_range(0..first.len_utf8(), &first.to_uppercase().to_string());
                }
                name
            }
            Detail::Shallow | Detail::Full => runtime.fun.to_string(),
        };
        let mut tail = String::from(r#"],"fun":"#);
        push_str(&mut tail, &fun);
        let _ = write!(tail, r#","forces":{},"arity":{}}}"#, runtime.forces, runtime.fun.arity());

        self.out.push_str(r#"{"args":["#);
        match how.detail {
            Detail::Shallow => {
                for (i, arg) in runtime.args.iter().enumerate() {
                    if i > 0 {
                        self.out.push(',');
                    }
                    let child = self.child_at(ptr, "args", i);
                    self.push_placeholder(value_kind(arg).as_parts(), child);
                }
                self.out.push_str(&tail);
            }
            Detail::Plain | Detail::Full => {
                // The arguments of a partial application have always been written out in full in
                // the eager view, program terms included.
                let args_how = How { detail: how.detail, inline: how.inline || how.detail == Detail::Plain };
                tasks.push(Task::Owned(tail));
                for (i, arg) in runtime.args.iter().enumerate().rev() {
                    let child = self.child_at(ptr, "args", i);
                    tasks.push(Task::Value(arg, args_how, child));
                    if i > 0 {
                        tasks.push(Task::Text(","));
                    }
                }
            }
        }
    }

    fn frame<'a>(&mut self, frame: &'a Context, how: How, ptr: u32, tasks: &mut Vec<Task<'a>>) {
        match frame {
            Context::FrameAwaitArg(value, _) | Context::FrameAwaitFunValue(value, _) => {
                let tag = if matches!(frame, Context::FrameAwaitArg(..)) { "FrameAwaitArg" } else { "FrameAwaitFunValue" };
                let _ = write!(self.out, r#"{{"context_type":"{tag}","value":"#);
                tasks.push(Task::Text("}"));
                let child = self.child(ptr, Segment::Field("value"));
                tasks.push(Task::Value(value, how, child));
            }
            Context::FrameAwaitFunTerm(env, term, _) => {
                self.out.push_str(r#"{"context_type":"FrameAwaitFunTerm","env":"#);
                tasks.push(Task::Text("}"));
                let child = self.child(ptr, Segment::Field("term"));
                tasks.push(Task::TermOrId(term, how, child));
                tasks.push(Task::Text(r#","term":"#));
                let child = self.child(ptr, Segment::Field("env"));
                tasks.push(Task::Env(env, how, child));
            }
            Context::FrameForce(_) => self.out.push_str(r#"{"context_type":"FrameForce"}"#),
            Context::NoFrame => self.out.push_str(r#"{"context_type":"NoFrame"}"#),
            Context::FrameConstr(env, tag, terms, values, _, term_id) => {
                self.out.push_str(r#"{"context_type":"FrameConstr","env":"#);
                match how.detail {
                    Detail::Plain => {
                        tasks.push(Task::Tail("]", *term_id));
                        for (i, value) in values.iter().enumerate().rev() {
                            tasks.push(Task::Value(value, how, NO_POINTER));
                            if i > 0 {
                                tasks.push(Task::Text(","));
                            }
                        }
                        tasks.push(Task::Text(r#"],"values":["#));
                        for (i, term) in terms.iter().enumerate().rev() {
                            tasks.push(Task::TermOrId(term, how, NO_POINTER));
                            if i > 0 {
                                tasks.push(Task::Text(","));
                            }
                        }
                        tasks.push(Task::Owned(format!(r#","tag":{tag},"terms":["#)));
                    }
                    // A lazy frame lists its pending terms and the values collected so far as
                    // placeholders, whatever the view's detail: each loads on its own.
                    Detail::Shallow | Detail::Full => {
                        let mut tail = format!(r#","tag":{tag},"terms":["#);
                        for i in 0..terms.len() {
                            if i > 0 {
                                tail.push(',');
                            }
                            let child = self.child_at(ptr, "terms", i);
                            self.placeholder(&mut tail, ("Term", "Term", None), child);
                        }
                        tail.push_str(r#"],"values":["#);
                        for (i, value) in values.iter().enumerate() {
                            if i > 0 {
                                tail.push(',');
                            }
                            let child = self.child_at(ptr, "values", i);
                            self.placeholder(&mut tail, value_kind(value).as_parts(), child);
                        }
                        tasks.push(Task::Tail("]", *term_id));
                        tasks.push(Task::Owned(tail));
                    }
                }
                let child = self.child(ptr, Segment::Field("env"));
                tasks.push(Task::Env(env, how, child));
            }
            Context::FrameCases(env, terms, _) => {
                self.out.push_str(r#"{"context_type":"FrameCases","env":"#);
                match how.detail {
                    Detail::Plain => {
                        tasks.push(Task::Text("]}"));
                        for (i, term) in terms.iter().enumerate().rev() {
                            tasks.push(Task::TermOrId(term, how, NO_POINTER));
                            if i > 0 {
                                tasks.push(Task::Text(","));
                            }
                        }
                        tasks.push(Task::Text(r#","terms":["#));
                    }
                    Detail::Shallow | Detail::Full => {
                        let mut tail = String::from(r#","terms":["#);
                        for i in 0..terms.len() {
                            if i > 0 {
                                tail.push(',');
                            }
                            let child = self.child_at(ptr, "terms", i);
                            self.placeholder(&mut tail, ("Term", "Term", None), child);
                        }
                        tail.push_str("]}");
                        tasks.push(Task::Owned(tail));
                    }
                }
                let child = self.child(ptr, Segment::Field("env"));
                tasks.push(Task::Env(env, how, child));
            }
        }
    }

    fn state<'a>(&mut self, state: &'a MachineState, how: How, ptr: u32, tasks: &mut Vec<Task<'a>>) {
        match state {
            MachineState::Return(frame, value) => {
                self.out.push_str(r#"{"machine_state_type":"Return","context":"#);
                tasks.push(Task::Text("}"));
                let child = self.child(ptr, Segment::Field("value"));
                tasks.push(Task::Value(value, how, child));
                tasks.push(Task::Text(r#","value":"#));
                let child = self.child(ptr, Segment::Field("context"));
                tasks.push(Task::Frame(frame, how, child));
            }
            MachineState::Compute(frame, env, term) => {
                self.out.push_str(r#"{"machine_state_type":"Compute","context":"#);
                tasks.push(Task::Text("}"));
                let child = self.child(ptr, Segment::Field("term"));
                tasks.push(Task::TermOrId(term, how, child));
                tasks.push(Task::Text(r#","term":"#));
                let child = self.child(ptr, Segment::Field("env"));
                tasks.push(Task::Env(env, how, child));
                tasks.push(Task::Text(r#","env":"#));
                let child = self.child(ptr, Segment::Field("context"));
                tasks.push(Task::Frame(frame, how, child));
            }
            // A failed run is done too, on an `error` term that names the term that failed.
            MachineState::Done(term) => {
                self.out.push_str(r#"{"machine_state_type":"Done","term":"#);
                tasks.push(Task::Text("}"));
                let child = self.child(ptr, Segment::Field("term"));
                tasks.push(Task::TermOrId(term, how, child));
            }
        }
    }
}

/// What a placeholder says about the node it stands for.
struct Kind {
    type_name: &'static str,
    kind: String,
    length: Option<usize>,
}

impl Kind {
    fn as_parts(&self) -> (&str, &str, Option<usize>) {
        (self.type_name, &self.kind, self.length)
    }
}

fn value_kind(value: &Value) -> Kind {
    match value {
        Value::Con(constant) => {
            let constant_type = match constant.as_ref() {
                Constant::Integer(_) => "Integer",
                Constant::ByteString(_) => "ByteString",
                Constant::String(_) => "String",
                Constant::Bool(_) => "Bool",
                Constant::Unit => "Unit",
                Constant::ProtoList(_, _) => "ProtoList",
                Constant::ProtoArray(_, _) => "ProtoArray",
                Constant::ProtoPair(_, _, _, _) => "ProtoPair",
                Constant::Data(_) => "Data",
                Constant::Bls12_381G1Element(_)
                | Constant::Bls12_381G2Element(_)
                | Constant::Bls12_381MlResult(_)
                | Constant::Value(_) => "Unknown",
            };
            Kind { type_name: "Con", kind: constant_type.to_string(), length: None }
        }
        Value::Delay { .. } => Kind { type_name: "Delay", kind: "Delayed computation".to_string(), length: None },
        Value::Lambda { parameter_name, .. } => {
            Kind { type_name: "Lambda", kind: format!("λ{}", parameter_name.text), length: None }
        }
        Value::Builtin { fun, .. } => Kind { type_name: "Builtin", kind: format!("{fun:?}"), length: None },
        Value::Constr { tag, fields, .. } => {
            Kind { type_name: "Constr", kind: format!("Constructor #{tag}"), length: Some(fields.len()) }
        }
    }
}

fn constant_kind(constant: &Constant) -> Kind {
    let (type_name, kind, length) = match constant {
        Constant::Integer(i) => ("Integer", i.to_string(), None),
        Constant::ByteString(bytes) => ("ByteString", format!("{} bytes", bytes.len()), None),
        Constant::String(s) => ("String", format!("{} chars", s.len()), None),
        Constant::Bool(b) => ("Bool", b.to_string(), None),
        Constant::Unit => ("Unit", "()".to_string(), None),
        Constant::ProtoList(_, items) => ("ProtoList", format!("{} items", items.len()), Some(items.len())),
        Constant::ProtoArray(_, items) => ("ProtoArray", format!("{} items", items.len()), Some(items.len())),
        Constant::ProtoPair(..) => ("ProtoPair", "Pair".to_string(), None),
        Constant::Data(_) => ("Data", "PlutusData".to_string(), None),
        Constant::Bls12_381G1Element(_) => ("Bls12_381G1Element", "G1 point".to_string(), None),
        Constant::Bls12_381G2Element(_) => ("Bls12_381G2Element", "G2 point".to_string(), None),
        Constant::Bls12_381MlResult(_) => ("Bls12_381MlResult", "ML result".to_string(), None),
        Constant::Value(value) => ("Value", format!("{} policies", value.outer_size()), Some(value.outer_size())),
    };
    Kind { type_name, kind, length }
}

fn push_str(out: &mut String, s: &str) {
    match serde_json::to_string(s) {
        Ok(json) => out.push_str(&json),
        Err(_) => out.push_str("\"\""),
    }
}

/// Write a view of `root` with no handles: the eager views, a step's result, the program.
pub fn plain(root: Root<'_>, program: &HashSet<i32>) -> String {
    Writer::new(program, &[]).write(root, Detail::Plain)
}

/// JSON as written here, laid out the way `serde_json::to_string_pretty` lays it out: two spaces
/// a level, keys in the order they were written.
pub fn pretty(json: &str) -> String {
    let mut out = String::with_capacity(json.len() * 2);
    let mut depth = 0usize;
    let mut chars = json.chars().peekable();
    let newline = |out: &mut String, depth: usize| {
        out.push('\n');
        for _ in 0..depth {
            out.push_str("  ");
        }
    };

    while let Some(c) = chars.next() {
        match c {
            '"' => {
                out.push(c);
                while let Some(c) = chars.next() {
                    out.push(c);
                    match c {
                        '\\' => {
                            if let Some(escaped) = chars.next() {
                                out.push(escaped);
                            }
                        }
                        '"' => break,
                        _ => {}
                    }
                }
            }
            '{' | '[' => {
                let close = if c == '{' { '}' } else { ']' };
                out.push(c);
                if chars.peek() == Some(&close) {
                    out.push(close);
                    chars.next();
                } else {
                    depth += 1;
                    newline(&mut out, depth);
                }
            }
            '}' | ']' => {
                depth = depth.saturating_sub(1);
                newline(&mut out, depth);
                out.push(c);
            }
            ',' => {
                out.push(c);
                newline(&mut out, depth);
            }
            ':' => out.push_str(": "),
            _ => out.push(c),
        }
    }

    out
}

/// The frames of the machine's control stack, the one it returns into first first, down to the
/// `NoFrame` at the bottom; none once the machine is done.
pub fn frames(state: &MachineState) -> Vec<&Context> {
    let mut frames = Vec::new();
    let mut next = match state {
        MachineState::Return(context, _) | MachineState::Compute(context, _, _) => Some(context),
        MachineState::Done(_) => None,
    };
    while let Some(context) = next {
        frames.push(context);
        next = match context {
            Context::NoFrame => None,
            Context::FrameForce(rest)
            | Context::FrameAwaitFunTerm(_, _, rest)
            | Context::FrameAwaitArg(_, rest)
            | Context::FrameAwaitFunValue(_, rest)
            | Context::FrameConstr(_, _, _, _, rest, _)
            | Context::FrameCases(_, _, rest) => Some(rest.as_ref()),
        };
    }
    frames
}

// ── Navigation ───────────────────────────────────────────────────────────────────────────────
//
// A lazy view is asked for by path: the UI expands a node by the handle its placeholder carried.
// Each function walks the path down to the node it names, a segment at a time, and writes that
// node; a path that names nothing is refused with the reason, as it always was.

/// Where a walk down a path stands.
enum Cursor<'a> {
    /// A value, the path asking for the value it names (`navigate_to_value`).
    Value(&'a Value),
    /// A value whose path may also name its environment (`navigate_value_to_any`).
    ValueOrEnv(&'a Value),
    /// The values of an environment, by position.
    EnvValues(&'a Env),
    /// A term; `as_value` when it is the body of a closure, which is a term and not a value.
    Term { term: &'a Term<NamedDeBruijn>, as_value: bool },
    /// A constant; `in_term` holds the id of the `Constant` term it is the constant of.
    Constant { constant: &'a Constant, in_term: Option<i32> },
    Runtime(&'a BuiltinRuntime),
    Frame(&'a Context),
}

fn field(segment: Option<&PathSegment>) -> Option<&str> {
    match segment {
        Some(PathSegment::Field(name)) => Some(name.as_str()),
        _ => None,
    }
}

/// Walk `path` from `cursor`, and write the node it ends on at `detail`, its handles starting with
/// `base`.
fn walk<'a>(
    mut cursor: Cursor<'a>,
    mut path: &[PathSegment],
    program: &HashSet<i32>,
    base: &[String],
    detail: Detail,
) -> NavigationResult<String> {
    use NavigationResult::{Found, InvalidPath};

    let write = |root: Root<'a>| Found(Writer::new(program, base).write(root, detail));

    loop {
        cursor = match cursor {
            Cursor::Value(value) => {
                if path.is_empty() {
                    return write(Root::Value(value));
                }
                match (value, field(path.first())) {
                    (Value::Con(constant), Some("constant")) => {
                        path = &path[1..];
                        Cursor::Constant { constant, in_term: None }
                    }
                    (Value::Constr { fields, .. }, Some("fields")) => match path.get(1) {
                        Some(PathSegment::Index(index)) => match fields.get(*index) {
                            Some(field) => {
                                path = &path[2..];
                                Cursor::Value(field)
                            }
                            None => return InvalidPath(format!("Index {} out of bounds", index)),
                        },
                        _ => return InvalidPath("Expected index after 'fields'".to_string()),
                    },
                    (Value::Lambda { body, .. }, Some("body")) | (Value::Delay { body, .. }, Some("body")) => {
                        path = &path[1..];
                        Cursor::Term { term: body, as_value: true }
                    }
                    (Value::Lambda { env, .. }, Some("env")) | (Value::Delay { env, .. }, Some("env")) => {
                        if path.len() == 1 {
                            return InvalidPath("Cannot return env as a value".to_string());
                        }
                        path = &path[1..];
                        Cursor::EnvValues(env)
                    }
                    (Value::Builtin { runtime, .. }, Some("runtime")) => {
                        path = &path[1..];
                        Cursor::Runtime(runtime)
                    }
                    _ => return InvalidPath(format!("Cannot navigate path {:?} in value type", path)),
                }
            }
            Cursor::ValueOrEnv(value) => {
                if path.is_empty() {
                    return write(Root::Value(value));
                }
                match (value, field(path.first())) {
                    (Value::Lambda { env, .. }, Some("env")) | (Value::Delay { env, .. }, Some("env")) => {
                        if path.len() == 1 {
                            return write(Root::Env(env));
                        }
                        path = &path[1..];
                        Cursor::EnvValues(env)
                    }
                    _ => Cursor::Value(value),
                }
            }
            Cursor::EnvValues(env) => match path.first() {
                Some(PathSegment::Field(name)) if name == "values" => match path.get(1) {
                    Some(PathSegment::Index(index)) => match env.get(*index) {
                        Some(value) => {
                            path = &path[2..];
                            Cursor::Value(value)
                        }
                        None => return InvalidPath(format!("Index {} out of bounds in env", index)),
                    },
                    _ => return InvalidPath("Expected index after 'values'".to_string()),
                },
                Some(PathSegment::Index(index)) => match env.get(*index) {
                    Some(value) => {
                        path = &path[1..];
                        Cursor::Value(value)
                    }
                    None => return InvalidPath(format!("Index {} out of bounds in env", index)),
                },
                _ => return InvalidPath(format!("Invalid path segment for env: {:?}", path)),
            },
            Cursor::Term { term, as_value } => {
                if path.is_empty() {
                    if as_value {
                        // The path is good, but it leads to a term.
                        return InvalidPath("Body is a Term, cannot return as Value".to_string());
                    }
                    return write(Root::Term(term));
                }
                let indexed = |items: &'a [Term<NamedDeBruijn>], path: &[PathSegment], what: &str| match path.get(1) {
                    Some(PathSegment::Index(index)) => match items.get(*index) {
                        Some(item) => Ok(item),
                        None => Err(InvalidPath(format!("Index {} out of bounds in {}", index, what))),
                    },
                    _ => Err(InvalidPath(format!("Expected index after '{}'", what))),
                };
                match (term, field(path.first())) {
                    (Term::Delay { body, .. }, Some("term"))
                    | (Term::Force { body, .. }, Some("term"))
                    | (Term::Lambda { body, .. }, Some("body"))
                    | (Term::Apply { function: body, .. }, Some("function"))
                    | (Term::Apply { argument: body, .. }, Some("argument"))
                    | (Term::Case { constr: body, .. }, Some("constr")) => {
                        path = &path[1..];
                        Cursor::Term { term: body, as_value }
                    }
                    (Term::Constr { fields, .. }, Some("fields")) => match indexed(fields, path, "fields") {
                        Ok(field) => {
                            path = &path[2..];
                            Cursor::Term { term: field, as_value }
                        }
                        Err(error) => return error,
                    },
                    (Term::Case { branches, .. }, Some("branches")) => match indexed(branches, path, "branches") {
                        Ok(branch) => {
                            path = &path[2..];
                            Cursor::Term { term: branch, as_value }
                        }
                        Err(error) => return error,
                    },
                    (Term::Constant { value, uniq_id }, Some("constant")) => {
                        path = &path[1..];
                        if as_value {
                            // Only the path is checked: whatever it names is not a value.
                            match check_constant_path(value, path) {
                                Some(error) => return InvalidPath(error),
                                None => return InvalidPath("Body is a Term, cannot return as Value".to_string()),
                            }
                        }
                        Cursor::Constant { constant: value, in_term: Some(*uniq_id as i32) }
                    }
                    _ => return InvalidPath(format!("Cannot navigate path {:?} in term type", path)),
                }
            }
            Cursor::Constant { constant, in_term } => {
                let found = |constant| match in_term {
                    Some(id) => write(Root::TermConstant(id, constant)),
                    None => write(Root::Constant(constant)),
                };
                if path.is_empty() {
                    return found(constant);
                }
                match (constant, field(path.first())) {
                    (Constant::ProtoList(_, items) | Constant::ProtoArray(_, items), Some("values")) => match path.get(1) {
                        Some(PathSegment::Index(index)) => match items.get(*index) {
                            Some(item) => {
                                path = &path[2..];
                                Cursor::Constant { constant: item, in_term }
                            }
                            None => return InvalidPath(format!("Index {} out of bounds in constant list", index)),
                        },
                        _ => return InvalidPath("Expected index after 'values'".to_string()),
                    },
                    (Constant::ProtoPair(_, _, first, _), Some("first_element")) => {
                        path = &path[1..];
                        Cursor::Constant { constant: first, in_term }
                    }
                    (Constant::ProtoPair(_, _, _, second), Some("second_element")) => {
                        path = &path[1..];
                        Cursor::Constant { constant: second, in_term }
                    }
                    // Nothing is inside these: whatever the rest of the path, the constant itself.
                    (
                        Constant::Integer(_)
                        | Constant::ByteString(_)
                        | Constant::String(_)
                        | Constant::Bool(_)
                        | Constant::Unit
                        | Constant::Bls12_381G1Element(_)
                        | Constant::Bls12_381G2Element(_)
                        | Constant::Bls12_381MlResult(_)
                        | Constant::Value(_)
                        | Constant::Data(_),
                        _,
                    ) => return found(constant),
                    _ => return InvalidPath(format!("Invalid navigation path {:?} for constant", path)),
                }
            }
            Cursor::Runtime(runtime) => match path.first() {
                None => return InvalidPath("Cannot return runtime as value".to_string()),
                Some(PathSegment::Field(name)) if name == "args" => match path.get(1) {
                    Some(PathSegment::Index(index)) => match runtime.args.get(*index) {
                        Some(arg) => {
                            path = &path[2..];
                            Cursor::Value(arg)
                        }
                        None => return InvalidPath(format!("Index {} out of bounds in runtime args", index)),
                    },
                    _ => return InvalidPath("Expected index after 'args'".to_string()),
                },
                _ => return InvalidPath(format!("Cannot navigate path {:?} in runtime", path)),
            },
            Cursor::Frame(frame) => {
                if path.is_empty() {
                    return write(Root::Frame(frame));
                }
                match (frame, field(path.first())) {
                    (Context::FrameAwaitArg(value, _), Some("value"))
                    | (Context::FrameAwaitFunValue(value, _), Some("value")) => {
                        path = &path[1..];
                        Cursor::ValueOrEnv(value)
                    }
                    (Context::FrameConstr(_, _, _, values, _, _), Some("values")) => match path.get(1) {
                        Some(PathSegment::Index(index)) => match values.get(*index) {
                            Some(value) => {
                                path = &path[2..];
                                Cursor::ValueOrEnv(value)
                            }
                            None => return InvalidPath(format!("Index {} out of bounds in values", index)),
                        },
                        _ => return InvalidPath("Expected index after 'values'".to_string()),
                    },
                    (Context::FrameAwaitFunTerm(env, ..), Some("env"))
                    | (Context::FrameConstr(env, ..), Some("env"))
                    | (Context::FrameCases(env, ..), Some("env")) => {
                        if path.len() == 1 {
                            return write(Root::Env(env));
                        }
                        path = &path[1..];
                        Cursor::EnvValues(env)
                    }
                    _ => return InvalidPath(format!("Invalid path for context: {:?}", path)),
                }
            }
        };
    }
}

/// The reason a path inside a constant names nothing, if it names something.
fn check_constant_path(mut constant: &Constant, mut path: &[PathSegment]) -> Option<String> {
    loop {
        if path.is_empty() {
            return None;
        }
        match (constant, field(path.first())) {
            (Constant::ProtoList(_, items) | Constant::ProtoArray(_, items), Some("values")) => match path.get(1) {
                Some(PathSegment::Index(index)) => match items.get(*index) {
                    Some(item) => {
                        constant = item;
                        path = &path[2..];
                    }
                    None => return Some(format!("Index {} out of bounds in constant list", index)),
                },
                _ => return Some("Expected index after 'values'".to_string()),
            },
            (Constant::ProtoPair(_, _, first, _), Some("first_element")) => {
                constant = first;
                path = &path[1..];
            }
            (Constant::ProtoPair(_, _, _, second), Some("second_element")) => {
                constant = second;
                path = &path[1..];
            }
            (Constant::ProtoList(..) | Constant::ProtoArray(..) | Constant::ProtoPair(..), _) => {
                return Some(format!("Invalid navigation path {:?} for constant", path));
            }
            _ => return None,
        }
    }
}

/// The lazy view of the value at `path`.
pub fn value_at(
    value: &Value,
    path: &[PathSegment],
    program: &HashSet<i32>,
    base: &[String],
    detail: Detail,
) -> NavigationResult<String> {
    walk(Cursor::Value(value), path, program, base, detail)
}

/// The lazy view of the value at `path` among an environment's values.
pub fn env_value_at(
    env: &Env,
    path: &[PathSegment],
    program: &HashSet<i32>,
    base: &[String],
    detail: Detail,
) -> NavigationResult<String> {
    walk(Cursor::EnvValues(env), path, program, base, detail)
}

/// The lazy view of the term at `path`.
pub fn term_at(
    term: &Term<NamedDeBruijn>,
    path: &[PathSegment],
    program: &HashSet<i32>,
    base: &[String],
    detail: Detail,
) -> NavigationResult<String> {
    walk(Cursor::Term { term, as_value: false }, path, program, base, detail)
}

/// The lazy view of the node at `path` in a frame.
pub fn frame_at(
    frame: &Context,
    path: &[PathSegment],
    program: &HashSet<i32>,
    base: &[String],
    detail: Detail,
) -> NavigationResult<String> {
    walk(Cursor::Frame(frame), path, program, base, detail)
}
