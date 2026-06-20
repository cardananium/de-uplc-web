//! Decode a Plutus `ScriptContext` (raw `PlutusData`) back into the engine's named
//! `SerializableScriptContext` — the inverse of `uplc`'s `to_plutus_data`. Used by the debugger's
//! "Show context" for a manually-supplied (parts-mode) context, so the user sees named tx_info
//! fields instead of a positional Data tree.
//!
//! LOSSY by construction (the Plutus encoding is a projection of the tx, not a round-trip):
//!  - addresses carry no network id → reconstructed as mainnet bech32 (best-effort);
//!  - redeemers carry only `data` (tag derived from the purpose; index/ex_units unknown → 0);
//!  - certificates drop deposits/anchors and collapse StakeRegistration/Reg (+ PoolRegistration
//!    keeps only operator+vrf); governance anchors aren't encoded; ParameterChange's full
//!    protocol-param update is not reconstructed (left empty).
//! Everything else (inputs/outputs/value/mint/fee/validity/signatories/datums/purpose/votes/…) is
//! faithful.

use num_bigint::{BigInt as NumBigInt, Sign as NumSign};
use pallas_addresses::{Address, Network, ShelleyAddress, ShelleyDelegationPart, ShelleyPaymentPart};
use pallas_crypto::hash::{Hash, Hasher};
use pallas_primitives::{BigInt as PBigInt, PlutusData as PD};
use uplc::ast::Data;
use uplc::tx::to_plutus_data::ToPlutusData;

use crate::plutus_data::{SerializableBigInt, SerializablePlutusData};
use super::basic_types::*;
use super::certificates::*;
use super::governance::*;
use super::script_types::*;
use super::tx_info::*;

type R<T> = Result<T, String>;

// ── low-level PlutusData readers ────────────────────────────────────────────────────────────────

/// (logical constructor index, fields). Inverts the CBOR-tag scheme (121..=127 → 0..=6,
/// 1280..=1400 → 7..=127, tag 102 → any_constructor).
fn as_constr(d: &PD) -> R<(u64, Vec<PD>)> {
    match d {
        PD::Constr(c) => {
            let idx = if c.tag == 102 {
                c.any_constructor.ok_or("constr tag 102 without any_constructor")?
            } else if (121..=127).contains(&c.tag) {
                c.tag - 121
            } else if (1280..=1400).contains(&c.tag) {
                c.tag - 1280 + 7
            } else {
                return Err(format!("unexpected constr tag {}", c.tag));
            };
            Ok((idx, c.fields.iter().cloned().collect()))
        }
        _ => Err("expected Constr".to_string()),
    }
}

fn big_to_i128(bi: &PBigInt) -> R<i128> {
    match bi {
        PBigInt::Int(i) => i.to_string().parse::<i128>().map_err(|e| e.to_string()),
        PBigInt::BigUInt(b) => NumBigInt::from_bytes_be(NumSign::Plus, b.as_slice())
            .try_into().map_err(|_| "BigUInt overflow".to_string()),
        // CBOR negative bignum encodes -1 - n.
        PBigInt::BigNInt(b) => (-NumBigInt::from_bytes_be(NumSign::Plus, b.as_slice()) - 1i32)
            .try_into().map_err(|_| "BigNInt overflow".to_string()),
    }
}

fn as_i128(d: &PD) -> R<i128> {
    match d { PD::BigInt(bi) => big_to_i128(bi), _ => Err("expected BigInt".to_string()) }
}
fn as_u64(d: &PD) -> R<u64> { Ok(as_i128(d)?.max(0) as u64) }
fn as_i64(d: &PD) -> R<i64> { Ok(as_i128(d)? as i64) }
fn as_u32(d: &PD) -> R<u32> { Ok(as_i128(d)?.max(0) as u32) }
fn as_usize(d: &PD) -> R<usize> { Ok(as_i128(d)?.max(0) as usize) }

fn as_bytes(d: &PD) -> R<Vec<u8>> {
    match d { PD::BoundedBytes(b) => Ok(b.to_vec()), _ => Err("expected BoundedBytes".to_string()) }
}
fn as_hex(d: &PD) -> R<String> { Ok(hex::encode(as_bytes(d)?)) }

fn as_list(d: &PD) -> R<Vec<PD>> {
    match d {
        PD::Array(a) => Ok(a.iter().cloned().collect()),
        // a Vec<A> can also surface as a Constr-wrapped Def list in some encoders; accept Constr too
        _ => Err("expected Array".to_string()),
    }
}
fn as_map(d: &PD) -> R<Vec<(PD, PD)>> {
    match d { PD::Map(m) => Ok(m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()), _ => Err("expected Map".to_string()) }
}
/// Generic Option: Constr 0[x] => Some, Constr 1[] => None.
fn as_option(d: &PD) -> R<Option<PD>> {
    let (idx, f) = as_constr(d)?;
    match idx { 0 => Ok(f.into_iter().next()), 1 => Ok(None), _ => Err("bad Option constr".to_string()) }
}
fn ser_data(d: &PD) -> SerializablePlutusData { SerializablePlutusData::from_pallas(d) }

fn hash28(bytes: &[u8]) -> R<Hash<28>> {
    Ok(Hash::<28>::from(<[u8; 28]>::try_from(bytes).map_err(|_| "expected 28-byte hash")?))
}

// ── credentials / addresses ─────────────────────────────────────────────────────────────────────

fn decode_stake_credential(d: &PD) -> R<SerializableStakeCredential> {
    let (idx, f) = as_constr(d)?;
    let hash = as_hex(f.first().ok_or("credential missing hash")?)?;
    match idx {
        0 => Ok(SerializableStakeCredential::KeyHash { hash }),
        1 => Ok(SerializableStakeCredential::ScriptHash { hash }),
        _ => Err("bad credential constr".to_string()),
    }
}

fn decode_drep(d: &PD) -> R<SerializableDRep> {
    let (idx, f) = as_constr(d)?;
    match idx {
        0 => {
            let (sc, sf) = as_constr(f.first().ok_or("drep cred missing")?)?;
            let hash = as_hex(sf.first().ok_or("drep cred hash missing")?)?;
            match sc { 0 => Ok(SerializableDRep::Key { hash }), 1 => Ok(SerializableDRep::Script { hash }), _ => Err("bad drep cred".to_string()) }
        }
        1 => Ok(SerializableDRep::Abstain),
        2 => Ok(SerializableDRep::NoConfidence),
        _ => Err("bad drep constr".to_string()),
    }
}

enum Cred { Key(Vec<u8>), Script(Vec<u8>) }
fn read_cred(d: &PD) -> R<Cred> {
    let (idx, f) = as_constr(d)?;
    let b = as_bytes(f.first().ok_or("cred missing hash")?)?;
    match idx { 0 => Ok(Cred::Key(b)), 1 => Ok(Cred::Script(b)), _ => Err("bad cred".to_string()) }
}

/// Decode a Plutus Address (Constr 0[payment_cred, Option<stake>]) to a mainnet bech32 string
/// (network id is NOT in the Plutus encoding). On any failure, fall back to a credential string.
fn decode_address(d: &PD) -> String {
    decode_address_inner(d).unwrap_or_else(|_| "<unparseable address>".to_string())
}
fn decode_address_inner(d: &PD) -> R<String> {
    let (idx, f) = as_constr(d)?;
    if idx != 0 || f.len() != 2 { return Err("bad address shape".to_string()); }
    let payment = match read_cred(&f[0])? {
        Cred::Key(b) => ShelleyPaymentPart::Key(hash28(&b)?),
        Cred::Script(b) => ShelleyPaymentPart::Script(hash28(&b)?),
    };
    let delegation = match as_option(&f[1])? {
        None => ShelleyDelegationPart::Null,
        Some(stake) => {
            // Some(stake): Constr 0[StakeCredential] (inline) | Constr 1[slot,txidx,certidx] (pointer)
            let (sidx, sf) = as_constr(&stake)?;
            match sidx {
                0 => match read_cred(sf.first().ok_or("inline stake missing")?)? {
                    Cred::Key(b) => ShelleyDelegationPart::Key(hash28(&b)?),
                    Cred::Script(b) => ShelleyDelegationPart::Script(hash28(&b)?),
                },
                1 => ShelleyDelegationPart::Null, // pointer addresses (deprecated) → no delegation
                _ => ShelleyDelegationPart::Null,
            }
        }
    };
    let addr = ShelleyAddress::new(Network::Mainnet, payment, delegation);
    addr.to_bech32().map_err(|e| e.to_string())
}

/// V1/V2 withdrawal keys / Rewarding purpose: a bare stake credential → a mainnet stake-address bech32.
fn decode_reward_address(d: &PD) -> String {
    decode_reward_address_inner(d).unwrap_or_else(|_| "<unparseable stake address>".to_string())
}
fn decode_reward_address_inner(d: &PD) -> R<String> {
    // Build the raw stake-address bytes (header ++ 28-byte hash) and let pallas parse + bech32 it.
    let (header, hash) = match read_cred(d)? {
        Cred::Key(b) => (0xe1u8, b),    // stake key, mainnet (0xe0 | network 1)
        Cred::Script(b) => (0xf1u8, b), // stake script, mainnet (0xf0 | network 1)
    };
    if hash.len() != 28 { return Err("bad stake credential hash".to_string()); }
    let mut bytes = vec![header];
    bytes.extend_from_slice(&hash);
    Address::from_bytes(&bytes).map_err(|e| e.to_string())?.to_bech32().map_err(|e| e.to_string())
}

// ── value / mint ────────────────────────────────────────────────────────────────────────────────

fn decode_value(d: &PD) -> R<SerializableCardanoValue> {
    let mut coin: u64 = 0;
    let mut assets: Vec<SerializableAsset> = vec![];
    for (pk, pv) in as_map(d)? {
        let pid = as_bytes(&pk)?;
        let inner = as_map(&pv)?;
        if pid.is_empty() {
            for (ak, av) in inner { if as_bytes(&ak)?.is_empty() { coin = as_u64(&av)?; } }
        } else {
            let tokens = inner.iter()
                .map(|(ak, av)| Ok(SerializableToken { asset_name: as_hex(ak)?, quantity: as_i64(av)? }))
                .collect::<R<Vec<_>>>()?;
            assets.push(SerializableAsset { policy_id: hex::encode(&pid), tokens });
        }
    }
    Ok(if assets.is_empty() { SerializableCardanoValue::Coin { amount: coin } }
       else { SerializableCardanoValue::Multiasset { coin, assets } })
}

fn decode_mint(d: &PD) -> R<SerializableMintValue> {
    let mut mint_value: Vec<SerializableAsset> = vec![];
    for (pk, pv) in as_map(d)? {
        let pid = as_bytes(&pk)?;
        if pid.is_empty() { continue; } // zero-ada sentinel (WithZeroAdaAsset form)
        let tokens = as_map(&pv)?.iter()
            .map(|(ak, av)| Ok(SerializableToken { asset_name: as_hex(ak)?, quantity: as_i64(av)? }))
            .collect::<R<Vec<_>>>()?;
        mint_value.push(SerializableAsset { policy_id: hex::encode(&pid), tokens });
    }
    Ok(SerializableMintValue { mint_value })
}

// ── inputs / outputs ────────────────────────────────────────────────────────────────────────────

fn decode_tx_input(d: &PD) -> R<SerializableTransactionInput> {
    let (_idx, f) = as_constr(d)?;
    if f.len() != 2 { return Err("bad TransactionInput shape".to_string()); }
    // field[0] is either BoundedBytes(txid) (unwrapped, V3) or Constr 0[BoundedBytes] (wrapped, V1/V2)
    let transaction_id = match &f[0] {
        PD::BoundedBytes(_) => as_hex(&f[0])?,
        PD::Constr(_) => { let (_, inner) = as_constr(&f[0])?; as_hex(inner.first().ok_or("wrapped txid missing")?)? }
        _ => return Err("bad txid".to_string()),
    };
    Ok(SerializableTransactionInput { transaction_id, index: as_u64(&f[1])? })
}

fn decode_datum_option(d: &PD) -> R<Option<SerializableDatumOption>> {
    let (idx, f) = as_constr(d)?;
    match idx {
        0 => Ok(None),
        1 => Ok(Some(SerializableDatumOption::Hash { hash: as_hex(f.first().ok_or("datum hash missing")?)? })),
        2 => Ok(Some(SerializableDatumOption::Data { data: ser_data(f.first().ok_or("inline datum missing")?) })),
        _ => Err("bad datum option".to_string()),
    }
}

/// script_ref is encoded only as the script HASH (Option<BoundedBytes>); language/body are lost.
fn decode_script_ref(d: &PD) -> R<Option<SerializableScriptRef>> {
    match as_option(d)? {
        None => Ok(None),
        Some(b) => Ok(Some(SerializableScriptRef::PlutusV2Script { script: as_hex(&b)? })),
    }
}

fn decode_output(d: &PD) -> R<SerializableTransactionOutput> {
    let (_idx, f) = as_constr(d)?;
    let address = decode_address(f.first().ok_or("output address missing")?);
    let value = decode_value(f.get(1).ok_or("output value missing")?)?;
    if f.len() >= 4 {
        Ok(SerializableTransactionOutput::PostAlonzo {
            address, value,
            datum_option: decode_datum_option(&f[2])?,
            script_ref: decode_script_ref(&f[3])?,
        })
    } else {
        // V1 3-field form: field[2] is a generic Option<datum_hash> — Constr 0[hash] = Some, Constr 1[] = None.
        let datum_option = match f.get(2) {
            Some(opt) => match as_constr(opt)? {
                (0, hf) => hf.first().map(|h| Ok::<_, String>(SerializableDatumOption::Hash { hash: as_hex(h)? })).transpose()?,
                _ => None,
            },
            None => None,
        };
        Ok(SerializableTransactionOutput::PostAlonzo { address, value, datum_option, script_ref: None })
    }
}

fn decode_tx_in_info(d: &PD) -> R<SerializableTxInInfo> {
    let (_idx, f) = as_constr(d)?;
    if f.len() != 2 { return Err("bad TxInInfo shape".to_string()); }
    Ok(SerializableTxInInfo { out_ref: decode_tx_input(&f[0])?, resolved: decode_output(&f[1])? })
}

// ── time range ──────────────────────────────────────────────────────────────────────────────────

fn decode_bound(d: &PD) -> R<Option<u64>> {
    let (_i, f) = as_constr(d)?; // Constr 0[extended, closed_bool]
    let (et, ef) = as_constr(f.first().ok_or("bound missing extended")?)?;
    match et { 1 => Ok(Some(as_u64(ef.first().ok_or("finite bound missing")?)?)), _ => Ok(None) } // 0=NegInf, 2=PosInf
}
fn decode_time_range(d: &PD) -> R<SerializableTimeRange> {
    let (_i, f) = as_constr(d)?;
    Ok(SerializableTimeRange {
        lower_bound: decode_bound(f.first().ok_or("range missing lower")?)?,
        upper_bound: decode_bound(f.get(1).ok_or("range missing upper")?)?,
    })
}

// ── certificates ────────────────────────────────────────────────────────────────────────────────

/// V1/V2 certificates: `WithPartialCertificates` (to_plutus_data.rs:531-587) — a DIFFERENT, smaller
/// tag set (0-4) from the V3 `WithNeverRegistrationDeposit` form below.
fn decode_certificate_partial(d: &PD) -> R<SerializableCertificate> {
    let (idx, f) = as_constr(d)?;
    let cred = |i: usize| -> R<SerializableStakeCredential> { decode_stake_credential(f.get(i).ok_or("cert cred missing")?) };
    match idx {
        0 => Ok(SerializableCertificate::StakeRegistration { stake_credential: cred(0)? }),
        1 => Ok(SerializableCertificate::StakeDeregistration { stake_credential: cred(0)? }),
        2 => Ok(SerializableCertificate::StakeDelegation { stake_credential: cred(0)?, pool_keyhash: as_hex(&f[1])? }),
        3 => Ok(SerializableCertificate::PoolRegistration { pool_params: SerializablePoolParams {
            operator: as_hex(&f[0])?, vrf_keyhash: as_hex(&f[1])?, pledge: 0, cost: 0,
            margin: SerializableRational { numerator: 0, denominator: 1 }, reward_account: String::new(),
            pool_owners: vec![], relays: vec![], pool_metadata: None,
        } }),
        4 => Ok(SerializableCertificate::PoolRetirement { pool_keyhash: as_hex(&f[0])?, epoch: as_u64(&f[1])? }),
        _ => Err(format!("unknown V1/V2 certificate constr {idx}")),
    }
}

/// V3 certificates: `WithNeverRegistrationDeposit` (to_plutus_data.rs:589-739) — tags 0-10.
fn decode_certificate_full(d: &PD) -> R<SerializableCertificate> {
    let (idx, f) = as_constr(d)?;
    let cred = |i: usize| -> R<SerializableStakeCredential> { decode_stake_credential(f.get(i).ok_or("cert cred missing")?) };
    match idx {
        0 => Ok(SerializableCertificate::StakeRegistration { stake_credential: cred(0)? }),
        1 => Ok(SerializableCertificate::StakeDeregistration { stake_credential: cred(0)? }),
        2 => { // delegatee inner Constr: 0=pool,1=drep,2=pool+drep
            let stake_credential = cred(0)?;
            let (s, sf) = as_constr(&f[1])?;
            match s {
                0 => Ok(SerializableCertificate::StakeDelegation { stake_credential, pool_keyhash: as_hex(&sf[0])? }),
                1 => Ok(SerializableCertificate::VoteDeleg { stake_credential, drep: decode_drep(&sf[0])? }),
                _ => Ok(SerializableCertificate::StakeVoteDeleg { stake_credential, pool_keyhash: as_hex(&sf[0])?, drep: decode_drep(&sf[1])? }),
            }
        }
        3 => {
            let stake_credential = cred(0)?;
            let deposit = as_u64(&f[2])?;
            let (s, sf) = as_constr(&f[1])?;
            match s {
                0 => Ok(SerializableCertificate::StakeRegDeleg { stake_credential, pool_keyhash: as_hex(&sf[0])?, deposit }),
                1 => Ok(SerializableCertificate::VoteRegDeleg { stake_credential, drep: decode_drep(&sf[0])?, deposit }),
                _ => Ok(SerializableCertificate::StakeVoteRegDeleg { stake_credential, pool_keyhash: as_hex(&sf[0])?, drep: decode_drep(&sf[1])?, deposit }),
            }
        }
        4 => Ok(SerializableCertificate::RegDRepCert { drep_credential: cred(0)?, deposit: as_u64(&f[1])?, anchor: None }),
        5 => Ok(SerializableCertificate::UpdateDRepCert { drep_credential: cred(0)?, anchor: None }),
        6 => Ok(SerializableCertificate::UnRegDRepCert { drep_credential: cred(0)?, refund: as_u64(&f[1])? }),
        7 => Ok(SerializableCertificate::PoolRegistration { pool_params: SerializablePoolParams {
            operator: as_hex(&f[0])?, vrf_keyhash: as_hex(&f[1])?, pledge: 0, cost: 0,
            margin: SerializableRational { numerator: 0, denominator: 1 }, reward_account: String::new(),
            pool_owners: vec![], relays: vec![], pool_metadata: None,
        } }),
        8 => Ok(SerializableCertificate::PoolRetirement { pool_keyhash: as_hex(&f[0])?, epoch: as_u64(&f[1])? }),
        9 => Ok(SerializableCertificate::AuthCommitteeHot { committee_cold_credential: cred(0)?, committee_hot_credential: cred(1)? }),
        10 => Ok(SerializableCertificate::ResignCommitteeCold { committee_cold_credential: cred(0)?, anchor: None }),
        _ => Err(format!("unknown certificate constr {idx}")),
    }
}

// ── purpose / script info ───────────────────────────────────────────────────────────────────────

/// `v3` selects the encoding: V1/V2 (WithWrappedTransactionId — wrapped input, DOUBLE-wrapped
/// Rewarding credential, indexless Certifying with a PARTIAL cert) vs V3 (unwrapped input, single
/// credential, Certifying with an index + FULL cert, plus Voting/Proposing).
fn decode_script_purpose(d: &PD, v3: bool) -> R<SerializableScriptPurpose> {
    let (idx, f) = as_constr(d)?;
    match idx {
        0 => Ok(SerializableScriptPurpose::Minting { policy_id: as_hex(&f[0])? }),
        1 => Ok(SerializableScriptPurpose::Spending { utxo_ref: decode_tx_input(&f[0])? }),
        2 => {
            // V1/V2 wraps the credential in an extra Constr 0 (WithWrappedStakeCredential); V3 doesn't.
            let cred = if v3 { &f[0] } else { let (_w, wf) = as_constr(&f[0])?; return Ok(SerializableScriptPurpose::Rewarding { stake_credential: decode_stake_credential(wf.first().ok_or("rewarding cred")?)? }); };
            Ok(SerializableScriptPurpose::Rewarding { stake_credential: decode_stake_credential(cred)? })
        }
        3 => {
            if v3 { Ok(SerializableScriptPurpose::Certifying { index: as_usize(&f[0])?, certificate: decode_certificate_full(&f[1])? }) }
            else { Ok(SerializableScriptPurpose::Certifying { index: 0, certificate: decode_certificate_partial(f.last().ok_or("cert missing")?)? }) }
        }
        4 => Ok(SerializableScriptPurpose::Voting { voter: decode_voter(&f[0])? }),
        5 => Ok(SerializableScriptPurpose::Proposing { index: as_usize(&f[0])?, proposal: decode_proposal(&f[1])? }),
        _ => Err(format!("bad script purpose constr {idx}")),
    }
}

fn decode_script_info(d: &PD) -> R<SerializableScriptInfo> {
    let (idx, f) = as_constr(d)?;
    match idx {
        0 => Ok(SerializableScriptInfo::Minting { policy_id: as_hex(&f[0])? }),
        1 => Ok(SerializableScriptInfo::Spending { utxo_ref: decode_tx_input(&f[0])?, datum: as_option(&f[1])?.map(|x| ser_data(&x)) }),
        2 => Ok(SerializableScriptInfo::Rewarding { stake_credential: decode_stake_credential(&f[0])? }),
        3 => Ok(SerializableScriptInfo::Certifying { index: as_usize(&f[0])?, certificate: decode_certificate_full(&f[1])? }),
        4 => Ok(SerializableScriptInfo::Voting { voter: decode_voter(&f[0])? }),
        5 => Ok(SerializableScriptInfo::Proposing { index: as_usize(&f[0])?, proposal: decode_proposal(&f[1])? }),
        _ => Err(format!("bad script info constr {idx}")),
    }
}

// ── governance ──────────────────────────────────────────────────────────────────────────────────

fn decode_voter(d: &PD) -> R<SerializableVoter> {
    let (idx, f) = as_constr(d)?;
    match idx {
        0 => { let (s, sf) = as_constr(&f[0])?; let hash = as_hex(&sf[0])?; match s { 0 => Ok(SerializableVoter::ConstitutionalCommitteeKey { hash }), _ => Ok(SerializableVoter::ConstitutionalCommitteeScript { hash }) } }
        1 => { let (s, sf) = as_constr(&f[0])?; let hash = as_hex(&sf[0])?; match s { 0 => Ok(SerializableVoter::DRepKey { hash }), _ => Ok(SerializableVoter::DRepScript { hash }) } }
        2 => Ok(SerializableVoter::StakePoolKey { hash: as_hex(&f[0])? }),
        _ => Err("bad voter constr".to_string()),
    }
}
fn decode_vote(d: &PD) -> R<SerializableVote> {
    let (idx, _f) = as_constr(d)?;
    match idx { 0 => Ok(SerializableVote::No), 1 => Ok(SerializableVote::Yes), 2 => Ok(SerializableVote::Abstain), _ => Err("bad vote".to_string()) }
}
fn decode_voting_procedure(d: &PD) -> R<SerializableVotingProcedure> {
    Ok(SerializableVotingProcedure { vote: decode_vote(d)?, anchor: None })
}
fn decode_gov_action_id(d: &PD) -> R<SerializableGovActionId> {
    let (_i, f) = as_constr(d)?;
    Ok(SerializableGovActionId { transaction_id: as_hex(&f[0])?, action_index: as_u32(&f[1])? })
}
fn decode_gov_action(d: &PD) -> R<SerializableGovAction> {
    let (idx, f) = as_constr(d)?;
    let id = |x: &PD| -> R<Option<SerializableGovActionId>> { Ok(match as_option(x)? { Some(g) => Some(decode_gov_action_id(&g)?), None => None }) };
    match idx {
        // ParameterChange: full protocol-param update is NOT reconstructed (left empty).
        0 => Ok(SerializableGovAction::ParameterChange { gov_action_id: id(&f[0])?, protocol_params_update: Box::new(empty_pp_update()), policy_hash: opt_hex(&f[2])? }),
        1 => Ok(SerializableGovAction::HardForkInitiation { gov_action_id: id(&f[0])?, protocol_version: { let (_pi, pf) = as_constr(&f[1])?; SerializableProtocolVersion { major: as_u64(&pf[0])?, minor: as_u64(&pf[1])? } } }),
        2 => Ok(SerializableGovAction::TreasuryWithdrawals { withdrawals: as_map(&f[0])?.iter().map(|(k, v)| Ok((decode_reward_address(k), as_u64(v)?))).collect::<R<_>>()?, policy_hash: opt_hex(&f[1])? }),
        3 => Ok(SerializableGovAction::NoConfidence { gov_action_id: id(&f[0])? }),
        4 => Ok(SerializableGovAction::UpdateCommittee {
            gov_action_id: id(&f[0])?,
            members_to_remove: as_list(&f[1])?.iter().map(decode_stake_credential).collect::<R<_>>()?,
            members_to_add: as_map(&f[2])?.iter().map(|(k, v)| Ok((decode_stake_credential(k)?, as_u64(v)?))).collect::<R<_>>()?,
            quorum_threshold: { let (_qi, qf) = as_constr(&f[3])?; SerializableRational { numerator: as_u64(&qf[0])?, denominator: as_u64(&qf[1])? } },
        }),
        5 => Ok(SerializableGovAction::NewConstitution { gov_action_id: id(&f[0])?, constitution: { let (_ci, cf) = as_constr(&f[1])?; SerializableConstitution { anchor: empty_anchor(), guardrail_script: opt_hex(&cf[0])? } } }),
        6 => Ok(SerializableGovAction::Information),
        _ => Err(format!("bad gov action constr {idx}")),
    }
}
fn decode_proposal(d: &PD) -> R<SerializableProposalProcedure> {
    let (_i, f) = as_constr(d)?;
    Ok(SerializableProposalProcedure { deposit: as_u64(&f[0])?, reward_account: decode_reward_address(&f[1]), gov_action: decode_gov_action(&f[2])?, anchor: empty_anchor() })
}
fn opt_hex(d: &PD) -> R<Option<String>> { Ok(match as_option(d)? { Some(b) => Some(as_hex(&b)?), None => None }) }
fn empty_anchor() -> SerializableAnchor { SerializableAnchor { url: String::new(), data_hash: String::new() } }
fn empty_pp_update() -> SerializableProtocolParamsUpdate {
    SerializableProtocolParamsUpdate {
        minfee_a: None, minfee_b: None, max_block_body_size: None, max_transaction_size: None, max_block_header_size: None,
        key_deposit: None, pool_deposit: None, maximum_epoch: None, desired_number_of_stake_pools: None,
        pool_pledge_influence: None, expansion_rate: None, treasury_growth_rate: None, min_pool_cost: None,
        ada_per_utxo_byte: None, cost_models_for_script_languages: None, execution_costs: None,
        max_tx_ex_units: None, max_block_ex_units: None, max_value_size: None, collateral_percentage: None,
        max_collateral_inputs: None, pool_voting_thresholds: None, drep_voting_thresholds: None,
        min_committee_size: None, committee_term_limit: None, governance_action_validity_period: None,
        governance_action_deposit: None, drep_deposit: None, drep_inactivity_period: None, minfee_refscript_cost_per_byte: None,
    }
}

// ── redeemers (in tx_info) ──────────────────────────────────────────────────────────────────────

fn purpose_tag(p: &SerializableScriptPurpose) -> SerializableRedeemerTag {
    match p {
        SerializableScriptPurpose::Spending { .. } => SerializableRedeemerTag::Spend,
        SerializableScriptPurpose::Minting { .. } => SerializableRedeemerTag::Mint,
        SerializableScriptPurpose::Certifying { .. } => SerializableRedeemerTag::Cert,
        SerializableScriptPurpose::Rewarding { .. } => SerializableRedeemerTag::Reward,
        SerializableScriptPurpose::Voting { .. } => SerializableRedeemerTag::Vote,
        SerializableScriptPurpose::Proposing { .. } => SerializableRedeemerTag::Propose,
    }
}
fn decode_redeemers(d: &PD, v3: bool) -> R<Vec<(SerializableScriptPurpose, SerializableRedeemer)>> {
    as_map(d)?.iter().map(|(k, v)| {
        let purpose = decode_script_purpose(k, v3)?;
        let red = SerializableRedeemer { tag: purpose_tag(&purpose), index: 0, data: ser_data(v), ex_units: SerializableExUnits::zero() };
        Ok((purpose, red))
    }).collect()
}

// ── tx_info bodies ──────────────────────────────────────────────────────────────────────────────

fn list_map<T>(d: &PD, f: impl Fn(&PD) -> R<T>) -> R<Vec<T>> { as_list(d)?.iter().map(f).collect() }
fn decode_data_map(d: &PD) -> R<Vec<(String, SerializablePlutusData)>> {
    // V2/V3 datums are a Map (KeyValuePairs); V1 is a Vec encoded as an Array of Constr0[hash, data].
    if let Ok(m) = as_map(d) {
        return m.iter().map(|(k, v)| Ok((as_hex(k)?, ser_data(v)))).collect();
    }
    list_map(d, |e| { let (_i, p) = as_constr(e)?; Ok((as_hex(&p[0])?, ser_data(&p[1]))) })
}
fn decode_signatories(d: &PD) -> R<Vec<String>> { list_map(d, as_hex) }
/// Wrapped withdrawals (V1/V2): Array/Map of (Constr0[stake_cred], coin).
fn decode_withdrawals_wrapped(d: &PD) -> R<Vec<(String, u64)>> {
    let pairs = as_map(d).or_else(|_| as_list(d).map(|l| l.into_iter().map(|e| {
        let (_i, p) = as_constr(&e).unwrap_or((0, vec![])); (p.first().cloned().unwrap_or(e.clone()), p.get(1).cloned().unwrap_or(e))
    }).collect()))?;
    pairs.iter().map(|(k, v)| { let (_i, cf) = as_constr(k)?; Ok((decode_reward_address(&cf[0]), as_u64(v)?)) }).collect()
}
/// V3 withdrawals: Map of (reward/stake address, coin) — keys are bare stake credentials (the reward
/// account is a stake address → Constr 0/1[hash]), NOT the 2-field Shelley address shape.
fn decode_withdrawals_addr(d: &PD) -> R<Vec<(String, u64)>> {
    as_map(d)?.iter().map(|(k, v)| Ok((decode_reward_address(k), as_u64(v)?))).collect()
}
fn decode_id(d: &PD) -> R<String> {
    match d { PD::BoundedBytes(_) => as_hex(d), PD::Constr(_) => { let (_i, f) = as_constr(d)?; as_hex(&f[0]) }, _ => Err("bad tx id".to_string()) }
}

fn decode_tx_info(d: &PD) -> R<SerializableTxInfo> {
    let (_i, f) = as_constr(d)?;
    match f.len() {
        10 => Ok(SerializableTxInfo::V1(SerializableTxInfoV1 {
            inputs: list_map(&f[0], decode_tx_in_info)?,
            outputs: list_map(&f[1], decode_output)?,
            fee: decode_value(&f[2])?,
            mint: decode_mint(&f[3])?,
            certificates: list_map(&f[4], decode_certificate_partial)?,
            withdrawals: decode_withdrawals_wrapped(&f[5])?,
            valid_range: decode_time_range(&f[6])?,
            signatories: decode_signatories(&f[7])?,
            data: decode_data_map(&f[8])?,
            redeemers: vec![],
            id: decode_id(&f[9])?,
        })),
        12 => Ok(SerializableTxInfo::V2(SerializableTxInfoV2 {
            inputs: list_map(&f[0], decode_tx_in_info)?,
            reference_inputs: list_map(&f[1], decode_tx_in_info)?,
            outputs: list_map(&f[2], decode_output)?,
            fee: decode_value(&f[3])?,
            mint: decode_mint(&f[4])?,
            certificates: list_map(&f[5], decode_certificate_partial)?,
            withdrawals: decode_withdrawals_wrapped(&f[6])?,
            valid_range: decode_time_range(&f[7])?,
            signatories: decode_signatories(&f[8])?,
            redeemers: decode_redeemers(&f[9], false)?,
            data: decode_data_map(&f[10])?,
            id: decode_id(&f[11])?,
        })),
        16 => Ok(SerializableTxInfo::V3(SerializableTxInfoV3 {
            inputs: list_map(&f[0], decode_tx_in_info)?,
            reference_inputs: list_map(&f[1], decode_tx_in_info)?,
            outputs: list_map(&f[2], decode_output)?,
            fee: as_u64(&f[3])?,
            mint: decode_mint(&f[4])?,
            certificates: list_map(&f[5], decode_certificate_full)?,
            withdrawals: decode_withdrawals_addr(&f[6])?,
            valid_range: decode_time_range(&f[7])?,
            signatories: decode_signatories(&f[8])?,
            redeemers: decode_redeemers(&f[9], true)?,
            data: decode_data_map(&f[10])?,
            id: decode_id(&f[11])?,
            votes: as_map(&f[12])?.iter().map(|(voter, vm)| {
                Ok((decode_voter(voter)?, as_map(vm)?.iter().map(|(aid, vp)| Ok((decode_gov_action_id(aid)?, decode_voting_procedure(vp)?))).collect::<R<Vec<_>>>()?))
            }).collect::<R<Vec<_>>>()?,
            proposal_procedures: list_map(&f[13], decode_proposal)?,
            current_treasury_amount: match as_option(&f[14])? { Some(x) => Some(as_u64(&x)?), None => None },
            treasury_donation: match as_option(&f[15])? { Some(x) => Some(as_u64(&x)?), None => None },
        })),
        n => Err(format!("unexpected TxInfo field count {n} (expected 10/12/16)")),
    }
}

// ── entry point ─────────────────────────────────────────────────────────────────────────────────

/// Decode a Plutus `ScriptContext` Data into the named `SerializableScriptContext`.
/// V1V2 = Constr 0[tx_info, purpose]; V3 = Constr 0[tx_info, redeemer, script_info].
pub fn script_context_from_data(d: &PD) -> R<SerializableScriptContext> {
    let (_idx, f) = as_constr(d)?;
    match f.len() {
        2 => Ok(SerializableScriptContext::V1V2 {
            tx_info: Box::new(decode_tx_info(&f[0])?),
            purpose: Box::new(decode_script_purpose(&f[1], false)?),
        }),
        3 => Ok(SerializableScriptContext::V3 {
            tx_info: Box::new(decode_tx_info(&f[0])?),
            redeemer: ser_data(&f[1]),
            purpose: Box::new(decode_script_info(&f[2])?),
        }),
        n => Err(format!("unexpected ScriptContext arity {n} (expected 2=V1V2 or 3=V3)")),
    }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// FORWARD: SerializableScriptContext -> PlutusData (lets a NAMED-JSON context be applied/round-
// tripped, the symmetric inverse of the decoders above; mirrors uplc::to_plutus_data). The named
// input's lossy-by-design fields (redeemer ex_units/tag/index, script_ref body/language, pool
// params, anchors, protocol-param-update) are encoded only as far as the Plutus form carries them.
// ══════════════════════════════════════════════════════════════════════════════════════════════

fn ec(ix: u64, fields: Vec<PD>) -> PD { Data::constr(ix, fields) }
/// Euclidean gcd (for reducing a rational to lowest terms, as `RationalNumber::to_plutus_data` does).
fn gcd(mut a: u64, mut b: u64) -> u64 { while b != 0 { let t = b; b = a % b; a = t; } a.max(1) }
fn eint(n: i128) -> PD { Data::integer(NumBigInt::from(n)) }
fn eopt(x: Option<PD>) -> PD { match x { Some(d) => ec(0, vec![d]), None => ec(1, vec![]) } }
fn ebytes(hex_str: &str) -> R<PD> { Ok(Data::bytestring(hex::decode(hex_str.trim()).map_err(|e| format!("bad hex {hex_str}: {e}"))?)) }
/// Address (or stake/reward address) bech32 → its Plutus Data (reuse uplc's forward Address encoder).
fn enc_address(bech32: &str) -> R<PD> {
    Address::from_bech32(bech32).map(|a| a.to_plutus_data()).map_err(|e| format!("bad address '{bech32}': {e}"))
}

fn enc_ser_data(d: &SerializablePlutusData) -> R<PD> {
    use SerializablePlutusData as S;
    Ok(match d {
        S::Constr { tag, any_constructor, fields } => {
            let fs = fields.iter().map(enc_ser_data).collect::<R<Vec<_>>>()?;
            let idx = if *tag == 102 { any_constructor.unwrap_or(0) }
                else if (121..=127).contains(tag) { tag - 121 }
                else if (1280..=1400).contains(tag) { tag - 1280 + 7 }
                else { any_constructor.unwrap_or(0) };
            Data::constr(idx, fs)
        }
        S::Map { key_value_pairs } => Data::map(key_value_pairs.iter().map(|kv| Ok((enc_ser_data(&kv.key)?, enc_ser_data(&kv.value)?))).collect::<R<Vec<_>>>()?),
        S::BigInt(bi) => {
            // Int holds a signed decimal; BigUInt a positive magnitude; BigNInt a positive
            // magnitude that represents a NEGATIVE value (the serializer drops the sign), so negate.
            let n = match bi {
                SerializableBigInt::Int(s) | SerializableBigInt::BigUInt(s) => s.parse::<NumBigInt>().map_err(|e| format!("bad bigint {s}: {e}"))?,
                SerializableBigInt::BigNInt(s) => -s.parse::<NumBigInt>().map_err(|e| format!("bad bigint {s}: {e}"))?,
            };
            Data::integer(n)
        }
        S::BoundedBytes { value } => ebytes(value)?,
        S::Array { values } => Data::list(values.iter().map(enc_ser_data).collect::<R<Vec<_>>>()?),
    })
}

fn enc_stake_credential(c: &SerializableStakeCredential) -> R<PD> {
    Ok(match c {
        SerializableStakeCredential::KeyHash { hash } => ec(0, vec![ebytes(hash)?]),
        SerializableStakeCredential::ScriptHash { hash } => ec(1, vec![ebytes(hash)?]),
    })
}
fn enc_drep(d: &SerializableDRep) -> R<PD> {
    Ok(match d {
        SerializableDRep::Key { hash } => ec(0, vec![ec(0, vec![ebytes(hash)?])]),
        SerializableDRep::Script { hash } => ec(0, vec![ec(1, vec![ebytes(hash)?])]),
        SerializableDRep::Abstain => ec(1, vec![]),
        SerializableDRep::NoConfidence => ec(2, vec![]),
    })
}

/// `zero_ada` = the V1/V2 `WithZeroAdaAsset<Value>` form (the coin pair is ALWAYS present, even at 0);
/// false = the V3 plain `Value` form (the coin pair appears only when coin > 0). The coin pair leads.
fn enc_value(v: &SerializableCardanoValue, zero_ada: bool) -> R<PD> {
    let mut pairs: Vec<(PD, PD)> = vec![];
    let (coin, assets) = match v {
        SerializableCardanoValue::Coin { amount } => (*amount, &Vec::new()),
        SerializableCardanoValue::Multiasset { coin, assets } => (*coin, assets),
    };
    if zero_ada || coin > 0 {
        pairs.push((Data::bytestring(vec![]), Data::map(vec![(Data::bytestring(vec![]), eint(coin as i128))])));
    }
    for a in assets {
        let toks = a.tokens.iter().map(|t| Ok((ebytes(&t.asset_name)?, eint(t.quantity as i128)))).collect::<R<Vec<_>>>()?;
        pairs.push((ebytes(&a.policy_id)?, Data::map(toks)));
    }
    Ok(Data::map(pairs))
}
/// `zero_ada` = the V1/V2 `WithZeroAdaAsset<MintValue>` form, which PREPENDS a `(empty_policy,
/// {empty_asset: 0})` sentinel (mint can't carry ada, so it is a fixed marker); V3 omits it.
fn enc_mint(m: &SerializableMintValue, zero_ada: bool) -> R<PD> {
    let mut pairs: Vec<(PD, PD)> = vec![];
    if zero_ada {
        pairs.push((Data::bytestring(vec![]), Data::map(vec![(Data::bytestring(vec![]), eint(0))])));
    }
    for a in m.mint_value.iter() {
        let toks = a.tokens.iter().map(|t| Ok((ebytes(&t.asset_name)?, eint(t.quantity as i128)))).collect::<R<Vec<_>>>()?;
        pairs.push((ebytes(&a.policy_id)?, Data::map(toks)));
    }
    Ok(Data::map(pairs))
}

fn enc_tx_input(i: &SerializableTransactionInput, wrapped: bool) -> R<PD> {
    let txid = if wrapped { ec(0, vec![ebytes(&i.transaction_id)?]) } else { ebytes(&i.transaction_id)? };
    Ok(ec(0, vec![txid, eint(i.index as i128)]))
}
fn enc_datum_option(d: &Option<SerializableDatumOption>) -> R<PD> {
    Ok(match d {
        None => ec(0, vec![]),
        Some(SerializableDatumOption::Hash { hash }) => ec(1, vec![ebytes(hash)?]),
        Some(SerializableDatumOption::Data { data }) => ec(2, vec![enc_ser_data(data)?]),
    })
}
fn enc_script_ref(s: &Option<SerializableScriptRef>) -> R<PD> {
    // Plutus carries only the script HASH = blake2b-224([lang_tag] ++ body), exactly as
    // ScriptRef::to_plutus_data does via compute_hash (native is hashed over its CBOR, tag 0; Plutus
    // V1/V2/V3 over their raw bytes, tags 1/2/3). The named `script` field holds that full body.
    Ok(match s {
        None => ec(1, vec![]),
        Some(r) => {
            let (body_hex, tag) = match r {
                SerializableScriptRef::NativeScript { script } => (script, 0u8),
                SerializableScriptRef::PlutusV1Script { script } => (script, 1u8),
                SerializableScriptRef::PlutusV2Script { script } => (script, 2u8),
                SerializableScriptRef::PlutusV3Script { script } => (script, 3u8),
            };
            let body = hex::decode(body_hex.trim()).map_err(|e| format!("bad script-ref hex: {e}"))?;
            // A 28-byte body is already a script hash (e.g. re-encoding a parts-mode decode, which
            // only recovered the hash) → use it as-is so the encoder is idempotent.
            let hash = if body.len() == 28 { body } else { Hasher::<224>::hash_tagged(&body, tag).as_ref().to_vec() };
            ec(0, vec![Data::bytestring(hash)])
        }
    })
}
fn enc_output(o: &SerializableTransactionOutput, legacy3: bool, zero_ada: bool) -> R<PD> {
    let (address, value, datum, sref) = match o {
        SerializableTransactionOutput::Legacy { address, value } => (address, value, &None, &None),
        SerializableTransactionOutput::PostAlonzo { address, value, datum_option, script_ref } => (address, value, datum_option, script_ref),
    };
    let mut fs = vec![enc_address(address)?, enc_value(value, zero_ada)?];
    if legacy3 {
        // V1: 3rd field is a generic Option<datum_hash> (Constr 0[hash]=Some / Constr 1[]=None).
        let dh = match datum { Some(SerializableDatumOption::Hash { hash }) => Some(ebytes(hash)?), _ => None };
        fs.push(eopt(dh));
    } else {
        fs.push(enc_datum_option(datum)?);
        fs.push(enc_script_ref(sref)?);
    }
    Ok(ec(0, fs))
}
fn enc_tx_in_info(t: &SerializableTxInInfo, wrapped: bool, legacy3: bool, zero_ada: bool) -> R<PD> {
    Ok(ec(0, vec![enc_tx_input(&t.out_ref, wrapped)?, enc_output(&t.resolved, legacy3, zero_ada)?]))
}

fn enc_bound(b: Option<u64>, lower: bool) -> PD {
    // Bound = Constr 0[extended, closure_bool]; Finite=Constr 1[t]; NegInf=Constr 0[]; PosInf=Constr 2[].
    let (ext, closed) = match b {
        Some(t) => (ec(1, vec![eint(t as i128)]), if lower { ec(1, vec![]) } else { ec(0, vec![]) }),
        None => (if lower { ec(0, vec![]) } else { ec(2, vec![]) }, ec(1, vec![])),
    };
    ec(0, vec![ext, closed])
}
fn enc_time_range(t: &SerializableTimeRange) -> PD {
    ec(0, vec![enc_bound(t.lower_bound, true), enc_bound(t.upper_bound, false)])
}

fn enc_cert_partial(c: &SerializableCertificate) -> R<PD> {
    use SerializableCertificate as C;
    Ok(match c {
        C::StakeRegistration { stake_credential } => ec(0, vec![enc_stake_credential(stake_credential)?]),
        C::StakeDeregistration { stake_credential } => ec(1, vec![enc_stake_credential(stake_credential)?]),
        C::StakeDelegation { stake_credential, pool_keyhash } => ec(2, vec![enc_stake_credential(stake_credential)?, ebytes(pool_keyhash)?]),
        C::PoolRegistration { pool_params } => ec(3, vec![ebytes(&pool_params.operator)?, ebytes(&pool_params.vrf_keyhash)?]),
        C::PoolRetirement { pool_keyhash, epoch } => ec(4, vec![ebytes(pool_keyhash)?, eint(*epoch as i128)]),
        _ => return Err("certificate not representable in V1/V2 (partial) form".to_string()),
    })
}
fn enc_cert_full(c: &SerializableCertificate) -> R<PD> {
    use SerializableCertificate as C;
    let none = ec(1, vec![]);
    Ok(match c {
        C::StakeRegistration { stake_credential } | C::Reg { stake_credential, .. } => ec(0, vec![enc_stake_credential(stake_credential)?, none]),
        C::StakeDeregistration { stake_credential } | C::UnReg { stake_credential, .. } => ec(1, vec![enc_stake_credential(stake_credential)?, none]),
        C::StakeDelegation { stake_credential, pool_keyhash } => ec(2, vec![enc_stake_credential(stake_credential)?, ec(0, vec![ebytes(pool_keyhash)?])]),
        C::VoteDeleg { stake_credential, drep } => ec(2, vec![enc_stake_credential(stake_credential)?, ec(1, vec![enc_drep(drep)?])]),
        C::StakeVoteDeleg { stake_credential, pool_keyhash, drep } => ec(2, vec![enc_stake_credential(stake_credential)?, ec(2, vec![ebytes(pool_keyhash)?, enc_drep(drep)?])]),
        C::StakeRegDeleg { stake_credential, pool_keyhash, deposit } => ec(3, vec![enc_stake_credential(stake_credential)?, ec(0, vec![ebytes(pool_keyhash)?]), eint(*deposit as i128)]),
        C::VoteRegDeleg { stake_credential, drep, deposit } => ec(3, vec![enc_stake_credential(stake_credential)?, ec(1, vec![enc_drep(drep)?]), eint(*deposit as i128)]),
        C::StakeVoteRegDeleg { stake_credential, pool_keyhash, drep, deposit } => ec(3, vec![enc_stake_credential(stake_credential)?, ec(2, vec![ebytes(pool_keyhash)?, enc_drep(drep)?]), eint(*deposit as i128)]),
        C::RegDRepCert { drep_credential, deposit, .. } => ec(4, vec![enc_stake_credential(drep_credential)?, eint(*deposit as i128)]),
        C::UpdateDRepCert { drep_credential, .. } => ec(5, vec![enc_stake_credential(drep_credential)?]),
        C::UnRegDRepCert { drep_credential, refund } => ec(6, vec![enc_stake_credential(drep_credential)?, eint(*refund as i128)]),
        C::PoolRegistration { pool_params } => ec(7, vec![ebytes(&pool_params.operator)?, ebytes(&pool_params.vrf_keyhash)?]),
        C::PoolRetirement { pool_keyhash, epoch } => ec(8, vec![ebytes(pool_keyhash)?, eint(*epoch as i128)]),
        C::AuthCommitteeHot { committee_cold_credential, committee_hot_credential } => ec(9, vec![enc_stake_credential(committee_cold_credential)?, enc_stake_credential(committee_hot_credential)?]),
        C::ResignCommitteeCold { committee_cold_credential, .. } => ec(10, vec![enc_stake_credential(committee_cold_credential)?]),
    })
}

fn enc_voter(v: &SerializableVoter) -> R<PD> {
    Ok(match v {
        SerializableVoter::ConstitutionalCommitteeKey { hash } => ec(0, vec![ec(0, vec![ebytes(hash)?])]),
        SerializableVoter::ConstitutionalCommitteeScript { hash } => ec(0, vec![ec(1, vec![ebytes(hash)?])]),
        SerializableVoter::DRepKey { hash } => ec(1, vec![ec(0, vec![ebytes(hash)?])]),
        SerializableVoter::DRepScript { hash } => ec(1, vec![ec(1, vec![ebytes(hash)?])]),
        SerializableVoter::StakePoolKey { hash } => ec(2, vec![ebytes(hash)?]),
    })
}
fn enc_voting_procedure(p: &SerializableVotingProcedure) -> PD {
    match p.vote { SerializableVote::No => ec(0, vec![]), SerializableVote::Yes => ec(1, vec![]), SerializableVote::Abstain => ec(2, vec![]) }
}
fn enc_gov_action_id(g: &SerializableGovActionId) -> R<PD> { Ok(ec(0, vec![ebytes(&g.transaction_id)?, eint(g.action_index as i128)])) }
fn enc_opt_id(g: &Option<SerializableGovActionId>) -> R<PD> { Ok(eopt(match g { Some(x) => Some(enc_gov_action_id(x)?), None => None })) }
fn enc_opt_hash(h: &Option<String>) -> R<PD> { Ok(eopt(match h { Some(s) => Some(ebytes(s)?), None => None })) }
fn enc_gov_action(a: &SerializableGovAction) -> R<PD> {
    use SerializableGovAction as G;
    Ok(match a {
        // protocol-param update is not reconstructed from the named form → empty Map.
        G::ParameterChange { gov_action_id, policy_hash, .. } => ec(0, vec![enc_opt_id(gov_action_id)?, Data::map(vec![]), enc_opt_hash(policy_hash)?]),
        G::HardForkInitiation { gov_action_id, protocol_version } => ec(1, vec![enc_opt_id(gov_action_id)?, ec(0, vec![eint(protocol_version.major as i128), eint(protocol_version.minor as i128)])]),
        G::TreasuryWithdrawals { withdrawals, policy_hash } => ec(2, vec![Data::map(withdrawals.iter().map(|(a, c)| Ok((enc_address(a)?, eint(*c as i128)))).collect::<R<Vec<_>>>()?), enc_opt_hash(policy_hash)?]),
        G::NoConfidence { gov_action_id } => ec(3, vec![enc_opt_id(gov_action_id)?]),
        G::UpdateCommittee { gov_action_id, members_to_remove, members_to_add, quorum_threshold } => {
            // The quorum rational is reduced to lowest terms, matching RationalNumber::to_plutus_data.
            let g = gcd(quorum_threshold.numerator, quorum_threshold.denominator);
            ec(4, vec![
                enc_opt_id(gov_action_id)?,
                Data::list(members_to_remove.iter().map(enc_stake_credential).collect::<R<Vec<_>>>()?),
                Data::map(members_to_add.iter().map(|(c, e)| Ok((enc_stake_credential(c)?, eint(*e as i128)))).collect::<R<Vec<_>>>()?),
                ec(0, vec![eint((quorum_threshold.numerator / g) as i128), eint((quorum_threshold.denominator / g) as i128)]),
            ])
        }
        G::NewConstitution { gov_action_id, constitution } => ec(5, vec![enc_opt_id(gov_action_id)?, ec(0, vec![enc_opt_hash(&constitution.guardrail_script)?])]),
        G::Information => ec(6, vec![]),
    })
}
fn enc_proposal(p: &SerializableProposalProcedure) -> R<PD> {
    Ok(ec(0, vec![eint(p.deposit as i128), enc_address(&p.reward_account)?, enc_gov_action(&p.gov_action)?]))
}

fn enc_purpose(p: &SerializableScriptPurpose, v3: bool) -> R<PD> {
    use SerializableScriptPurpose as P;
    Ok(match p {
        P::Minting { policy_id } => ec(0, vec![ebytes(policy_id)?]),
        P::Spending { utxo_ref } => ec(1, vec![enc_tx_input(utxo_ref, !v3)?]),
        P::Rewarding { stake_credential } => {
            let cred = enc_stake_credential(stake_credential)?;
            ec(2, vec![if v3 { cred } else { ec(0, vec![cred]) }])
        }
        P::Certifying { index, certificate } => if v3 { ec(3, vec![eint(*index as i128), enc_cert_full(certificate)?]) } else { ec(3, vec![enc_cert_partial(certificate)?]) },
        P::Voting { voter } => ec(4, vec![enc_voter(voter)?]),
        P::Proposing { index, proposal } => ec(5, vec![eint(*index as i128), enc_proposal(proposal)?]),
    })
}
fn enc_script_info(s: &SerializableScriptInfo) -> R<PD> {
    use SerializableScriptInfo as S;
    Ok(match s {
        S::Minting { policy_id } => ec(0, vec![ebytes(policy_id)?]),
        S::Spending { utxo_ref, datum } => ec(1, vec![enc_tx_input(utxo_ref, false)?, eopt(match datum { Some(d) => Some(enc_ser_data(d)?), None => None })]),
        S::Rewarding { stake_credential } => ec(2, vec![enc_stake_credential(stake_credential)?]),
        S::Certifying { index, certificate } => ec(3, vec![eint(*index as i128), enc_cert_full(certificate)?]),
        S::Voting { voter } => ec(4, vec![enc_voter(voter)?]),
        S::Proposing { index, proposal } => ec(5, vec![eint(*index as i128), enc_proposal(proposal)?]),
    })
}

fn enc_redeemers(r: &[(SerializableScriptPurpose, SerializableRedeemer)], v3: bool) -> R<PD> {
    Ok(Data::map(r.iter().map(|(p, red)| Ok((enc_purpose(p, v3)?, enc_ser_data(&red.data)?))).collect::<R<Vec<_>>>()?))
}
fn enc_data_field(d: &[(String, SerializablePlutusData)], as_map: bool) -> R<PD> {
    if as_map { Ok(Data::map(d.iter().map(|(h, x)| Ok((ebytes(h)?, enc_ser_data(x)?))).collect::<R<Vec<_>>>()?)) }
    else { Ok(Data::list(d.iter().map(|(h, x)| Ok(ec(0, vec![ebytes(h)?, enc_ser_data(x)?]))).collect::<R<Vec<_>>>()?)) }
}
/// V1/V2 withdrawals: key = Constr 0[stake credential]; the named value is a (reward-address-bech32, coin).
fn enc_withdrawals_wrapped(w: &[(String, u64)]) -> R<PD> {
    Ok(Data::map(w.iter().map(|(a, c)| Ok((ec(0, vec![enc_address(a)?]), eint(*c as i128)))).collect::<R<Vec<_>>>()?))
}
fn enc_withdrawals_addr(w: &[(String, u64)]) -> R<PD> {
    Ok(Data::map(w.iter().map(|(a, c)| Ok((enc_address(a)?, eint(*c as i128)))).collect::<R<Vec<_>>>()?))
}
fn enc_signatories(s: &[String]) -> R<PD> { Ok(Data::list(s.iter().map(|h| ebytes(h)).collect::<R<Vec<_>>>()?)) }

fn enc_tx_info(t: &SerializableTxInfo) -> R<PD> {
    Ok(match t {
        SerializableTxInfo::V1(v) => ec(0, vec![
            Data::list(v.inputs.iter().map(|i| enc_tx_in_info(i, true, true, true)).collect::<R<Vec<_>>>()?),
            Data::list(v.outputs.iter().map(|o| enc_output(o, true, true)).collect::<R<Vec<_>>>()?),
            enc_value(&v.fee, true)?, enc_mint(&v.mint, true)?,
            Data::list(v.certificates.iter().map(enc_cert_partial).collect::<R<Vec<_>>>()?),
            enc_withdrawals_wrapped(&v.withdrawals)?, enc_time_range(&v.valid_range), enc_signatories(&v.signatories)?,
            enc_data_field(&v.data, false)?, ec(0, vec![ebytes(&v.id)?]),
        ]),
        SerializableTxInfo::V2(v) => ec(0, vec![
            Data::list(v.inputs.iter().map(|i| enc_tx_in_info(i, true, false, true)).collect::<R<Vec<_>>>()?),
            Data::list(v.reference_inputs.iter().map(|i| enc_tx_in_info(i, true, false, true)).collect::<R<Vec<_>>>()?),
            Data::list(v.outputs.iter().map(|o| enc_output(o, false, true)).collect::<R<Vec<_>>>()?),
            enc_value(&v.fee, true)?, enc_mint(&v.mint, true)?,
            Data::list(v.certificates.iter().map(enc_cert_partial).collect::<R<Vec<_>>>()?),
            enc_withdrawals_wrapped(&v.withdrawals)?, enc_time_range(&v.valid_range), enc_signatories(&v.signatories)?,
            enc_redeemers(&v.redeemers, false)?, enc_data_field(&v.data, true)?, ec(0, vec![ebytes(&v.id)?]),
        ]),
        SerializableTxInfo::V3(v) => ec(0, vec![
            Data::list(v.inputs.iter().map(|i| enc_tx_in_info(i, false, false, false)).collect::<R<Vec<_>>>()?),
            Data::list(v.reference_inputs.iter().map(|i| enc_tx_in_info(i, false, false, false)).collect::<R<Vec<_>>>()?),
            Data::list(v.outputs.iter().map(|o| enc_output(o, false, false)).collect::<R<Vec<_>>>()?),
            eint(v.fee as i128), enc_mint(&v.mint, false)?,
            Data::list(v.certificates.iter().map(enc_cert_full).collect::<R<Vec<_>>>()?),
            enc_withdrawals_addr(&v.withdrawals)?, enc_time_range(&v.valid_range), enc_signatories(&v.signatories)?,
            enc_redeemers(&v.redeemers, true)?, enc_data_field(&v.data, true)?, ebytes(&v.id)?,
            Data::map(v.votes.iter().map(|(voter, procs)| Ok((enc_voter(voter)?, Data::map(procs.iter().map(|(aid, vp)| Ok((enc_gov_action_id(aid)?, enc_voting_procedure(vp)))).collect::<R<Vec<_>>>()?)))).collect::<R<Vec<_>>>()?),
            Data::list(v.proposal_procedures.iter().map(enc_proposal).collect::<R<Vec<_>>>()?),
            eopt(v.current_treasury_amount.map(|x| eint(x as i128))),
            eopt(v.treasury_donation.map(|x| eint(x as i128))),
        ]),
    })
}

/// Encode a NAMED `SerializableScriptContext` back to Plutus `PlutusData` (the applied context arg).
pub fn script_context_to_data(ctx: &SerializableScriptContext) -> R<PD> {
    match ctx {
        SerializableScriptContext::V1V2 { tx_info, purpose } => Ok(ec(0, vec![enc_tx_info(tx_info)?, enc_purpose(purpose, false)?])),
        SerializableScriptContext::V3 { tx_info, redeemer, purpose } => Ok(ec(0, vec![enc_tx_info(tx_info)?, enc_ser_data(redeemer)?, enc_script_info(purpose)?])),
    }
}