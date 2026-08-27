use std::collections::{HashMap, HashSet};

use crate::DebuggerEngine;
use crate::budget::SerializableBudget;
use crate::debugger_engine::{new_session_from_parts, new_session_from_program, SessionController};
use crate::profile::{
    ProfileAttribution, ProfileOutcome, ProfileRunOutcome, ProfileRunResult, ProfileRunner,
    ProfileTerm, SerializableProfile,
};
use pallas_primitives::conway::Language;
use uplc::{
    ast::{Constant, NamedDeBruijn, Term},
    builtins::DefaultFunction,
    machine::{cost_model::CostModel, Context, TERM_COUNT},
};

const TX_HEX: &str = "84a900838258206153c1e9a628fc2bc1ebc82d1f6b6d360c3f5a895171cfd8a792541ab51f7509018258206153c1e9a628fc2bc1ebc82d1f6b6d360c3f5a895171cfd8a792541ab51f750902825820cb78d0612a8a54e4cbe43c90e23dc7739f0b27fffbd7caa5368d9b98047601b1000183a400581d7118c91bdff54ad8f4d3618818f36b99e401caa7eab153b42f51311cb001821a002297b4a2581c9e3ca7a4d3ae25b02b1ce833b8d85bd8a6a8fda186a93a0bc504d454a14001581cd30ee8c513b3fabada55d802a5ca5bb12e43b42027017309ed71ed4ba14001028201d8184dd8799f1b00003b1e458e2080ff03d81858c68200830304868200581cde4abaf30e894ec9243b8bb97ad7414b1d3086833ad8bf12d10130d08200581caf62c226e169c1fb4e84eb4286bac6bfda702ecf3a49f9fdbe5bf78f8200581cd8c1b4ad263333c687291894fb466a3bc1429565c2541e54b8901e158200581c5d5bbb9f55ea3524307dd6ed28e72b156f60ffc181cc20b89f2f13338200581cb6ee5605641b0f573312699348d19e71765d0010a4cac2c4fc9678178200581cde398fc701ce1b4adb7119d68c1d9710cfb70dec6989e31acc6d274f82583901de4abaf30e894ec9243b8bb97ad7414b1d3086833ad8bf12d10130d06a60e1593e83c2753d38ee6183d1d7cdb0a1c5cba657c798885122a6821a001b9f18a4581c6ac8ef33b510ec004fe11585f7c5a9f0c07f0c23428ab4f29c1d7d10a1444d454c441a004c4b40581ca0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235a145484f534b591a0134fd9a581ca2944573e99d2ed3055b808eaa264f0bf119e01fc6b18863067c63e4a1444d454c441b000000037e2100d0581cb06729158210bf1ba13f8f3d7d422a918d3eaa82561a705552a2568ba158194d656c642042616e6b204d616e6167657220763120333939370182583901de4abaf30e894ec9243b8bb97ad7414b1d3086833ad8bf12d10130d06a60e1593e83c2753d38ee6183d1d7cdb0a1c5cba657c798885122a61a1a895ce7021a00042ee309a2581c4d564c6e31f771d71471437ea9f0e60038be09619755f8720eb093cda14020581ca2944573e99d2ed3055b808eaa264f0bf119e01fc6b18863067c63e4a1444d454c443b00000da475abefff0b58201b22ceb7916b9a373af4c0bcd14d59bfc3f0bb88702f5f6214463ae2dc94a9df0d818258206153c1e9a628fc2bc1ebc82d1f6b6d360c3f5a895171cfd8a792541ab51f7509021082583901de4abaf30e894ec9243b8bb97ad7414b1d3086833ad8bf12d10130d06a60e1593e83c2753d38ee6183d1d7cdb0a1c5cba657c798885122a61a1a87aa79111a000646551283825820125192e26ab0fedcfb32d54176d4cffdbde39b22f68d13f64c85bc7d64bd71a501825820125192e26ab0fedcfb32d54176d4cffdbde39b22f68d13f64c85bc7d64bd71a503825820cb78d0612a8a54e4cbe43c90e23dc7739f0b27fffbd7caa5368d9b98047601b100a2008482582059b84d8bda14d930893c601db44a4868206bb86e4d413637e19f9e8fb48e1103584051a8a5f8725842b78877e9852c6277bae5bb4b67cdbfe12311b63a64b1097eccafb8c26012e713b45842652fa5e2490f9ecdbdb4cb8a5b5006a529e1d814a20f825820772009ced9a45528d3a8b917eedd09949b724c07d7e0ffb1bced31dd0692acc85840cf655e22856912723907977cade87a887cba8e9e928d61efa6c600c03d4155f9b0caa76ec59270a6dbfb9091258106584416ea24ac68a3ea6de9c33065782405825820485e86a93ed036d20336391aab0419bf4cf2a7b47fbe7b62f8a0fa912954ecb8584051af180e31ce6baca4b404e7a3d4b942362dd36938dc2e3fe86dfb9388bc3ddd290821850080d8bf2e92f1d43e36c6cfcedb6f2bbf1823bec0e6aafbe113c3008258209e0fc2bceae4ffe26fffd8a91dcc7cd4578843415434ff565696b5ffd5ec1e725840dc28ca94bfd9070507e4ed8223afdd3f08e10790f6a86c08111523defa7fa84b6851c7f4276d25757a2f945cb72b9609e687e39085905ce33f04986b9c83af010582840002d87980821a0004bd501a07f45cee840101d87a80821a000191e71a02b3b3f4F5F6";
const UTXO_JSON: &str = "[{\"txHash\":\"125192e26ab0fedcfb32d54176d4cffdbde39b22f68d13f64c85bc7d64bd71a5\",\"outputIndex\":1,\"address\":\"addr1wypan0u8f2jsewz97nw0qydzy0k5k8xd2x6gtxgt4fuavastxq94l\",\"value\":{\"lovelace\":\"6646020\"},\"datumHash\":null,\"referenceScript\":{\"type\":\"PlutusV2\",\"script\":\"59052d01000032323232323232323232323232323232323232323232323232323232323232322223232323232323232323232323232323232323232325333033533303330363037002132323253302b33301d3021003012011153302b3301f33026002037375860660282a66056607060386eacc0cc04c4cdd79819981700d9819981700598101817998159981280081b1bac30320133031302c00130303031302b302d3302923302603530313032302c001375860600242646464a6605666603a00c0240222a6605666e3c00401854cc0accdc4801a410101a163a5fd341c2a6605666e252000003132323232323232533032533303d303f304100214a029444cdc398119bab303a01a0093041001375400aa6660746078004264068a66607200220662c2a666074607a004264068a66607200220662c2c607c00460780026ea8004ccccc0788c888c00800cc0f0004cdd2a40006605a98011e581ca2944573e99d2ed3055b808eaa264f0bf119e01fc6b18863067c63e4004bd701bab3033303430223034013200116302000f337026eb4c0c4c0b0064004dd69818181580408160b181b8009baa015301b302d302e3028301e013533302f3031002132029533302e0011028161533302f3032002132029533302e001102816163033002303100137540206030008a6660546058605c0042646404aa666054605200420482c6eb4c09c00458c0b8004dd5180a800981218129812980f80098101980e1980b180a980a004a5eb851e581c9e3ca7a4d3ae25b02b1ce833b8d85bd8a6a8fda186a93a0bc504d45400810140001bac3023004375660440046eb0c08400cc084c084004c080c080004c064c078c0640114ccc080c088c0900084c8c806d4ccc080c07c008406858dd6980e8008b18120009baa003233300e00148811ca2944573e99d2ed3055b808eaa264f0bf119e01fc6b18863067c63e4004881044d454c4400222533006330052323233533301f30223023002132223002003375c6038002244a002466e3c00401c52818118009baa301a3015300c001002133333004232223002003375660440026ea400c0049288a502223301722533301c00112250011533301d3375e604260340020082600a60340022600460360020024602844a666032002294054cc010c00cc05c0044c008c0600048cc05c00452891919299980c180d180e00109bae301500116301c001375460266004601c002460266026602600246464a66602c66e1d2004301a0021301300116301a0013754002464646666020600ca66602a60306032004260240022c6eb0c048c034c048c03400c800458c064004dd5180818089805800918079805180798081805000911299804198028010008998020018009119baf374e60120046e9cc024c038c02400488c94ccc044cdc4240040022c260280026660066eacc034c038c020004dd718068011bae300d300e0022223333004002480008cccc014009200075a6eac00400c8c8888cc034894ccc048004401454ccc04ccdd7980b980800080309802180c18080008980118088008009ba90012233300d00200114a04600e44a666018002297ae0132533300e30040011330050013003300c00213003300c002300a00157404601c6ea8005263002225333007001161533300835746600c0022600a0022c6002444a66600e002244a0022a6660106004600a002264446004006600a002266006004600c002464600446600400400246004466004004002ae855d12ab9f573497ae1011e581c1400f6b65c323065b3cad0bc73437884e3b9c4714624bde5cfe0132000810140001b8748000dc3a4004aae7555cf01\"}},{\"txHash\":\"125192e26ab0fedcfb32d54176d4cffdbde39b22f68d13f64c85bc7d64bd71a5\",\"outputIndex\":3,\"address\":\"addr1wypan0u8f2jsewz97nw0qydzy0k5k8xd2x6gtxgt4fuavastxq94l\",\"value\":{\"lovelace\":\"7779550\"},\"datumHash\":null,\"referenceScript\":{\"type\":\"PlutusV2\",\"script\":\"59063401000032323232323232323232323232323232323232323232323232322232323232323253330145333014301c302200213301622533301900114a0264a66602ea66602e66e212002001161301f00114a22600660360046660246eacc050c068c044c050c068c044c050004dd7180a00d9bae3014301a01b37586024601e6024601e00e26464646464646464a66603860466054004264646464a6602c604e60426603246603201a603e604a60380026eb0c07802854cc058c0a0c08400c54cc058cdc3998111129998128008a4000264a66604666ebcc0c400401c4c94ccc09c0045854ccc090d5d198140008a99981219baf303230220014c0105444d454c44001375a606260440022c2c6eacc0c00044c00cc09c008c080004dd5980f0040008991919191919191929980f2999814299981419b8800200114a22a66605066e1c0080044c8c94ccc0a8c0c80104cdc41bad3028002375a60500022940c0d8010c0d40105280a511323232533302b533302b303300213232533302d3035303b00213375e6e9c00cdd38008a50303900137540102a666056606800426464a66605a606c6076004266ebcdd38019ba700114a060720026ea80204c8c94ccc0b4c0d0c0ec0084cdd79ba7003374e0022940c0e4004dd5004099981598101814981780598101814981780525114a0606e004606e0026ea80184c8c8c8c8c8c8c8cdc49bad302d3033302a00433302633029035330290354bd702400000ea66605c606a60780042646464646464066a66606c606e00420642c6eb4c0c0004c0d40114ccc0c0c0dcc0f80084c8c8c8c8c8c8c8c8c8c80e54ccc0f0c0f401440e0594ccc0e0c0fc0084c8c8c8c8c80f14ccc0fcc10001440ec594ccc0ecc1080084c8c8c8c8c80fd4ccc108c10c01440f8594ccc0f8c11400854ccc0f8c120dc69bae303c00113203e53330413042001103d16161533303e30460021533303e3048371a6eb8c0f00044c80f94ccc104c10800440f4585858c128008c128004dd5181c8008a99981d9821801099191919191902029998219822001081f8b1bad303d0013042002375a607600260800046eb4c0e400458c11c008c11c004dd5181b0008a99981c182000109901c299981d800881b8b0b182200118220009baa303300130380055333033303a00215333033303d371a6eb8c0c40044c80cd4ccc0d8c0dc00440c8585854ccc0ccc0ec00854ccc0ccc0f4dc69bae3031001132033533303630370011032161616303f002303f0013754605c0022c60780026ea8c0b000458c0e8004dd5000a999815981a181c801098148008b181b8009baa3027302d302d3024001302600b3035002303400237540046ea8008c084008c080008c07000cc06c01cccc0848894ccc09400440084cc00cccc0652f5c211e581c6ac8ef33b510ec004fe11585f7c5a9f0c07f0c23428ab4f29c1d7d10008105444d454c440000118100009813000a4000004605266030605466030981091b000001941f2891a0004bd701980c260103d87980004bd701980b180a8049bac301b006301a00116302800137546030603c00a602e603a6028602e603a603a603a0026038603800260366036002602260280026020010603e6601c60406601c98011e581cd612be7ab0bdbd3d728b922e422da843de33ee71bd13c19e78b32080004bd7019807181025eb812f5c020262c60400026ea80194ccc044c0600084c80454ccc05000440405854ccc044c0640084c80454ccc05000440405858c074008c074004dd50011180a180d1baa0012233300c00200114a044466e00ccc020dd59805180818038009bae300a003375c601460200060044466ebcdd398028011ba73005300830050012300a22533300d00114bd7009929998059802000899802800980198078010980198078011804000aba0230133754002444666600800490001199980280124000eb4dd58008019191111980511299980680088028a99980519baf30183008001006130043017300800113002300e0010013752002ae8526573466002444a66600a002200426600666e0000920023006001480008c8c0088cc0080080048c0088cc00800800555cfaba24bd70811e581c9e3ca7a4d3ae25b02b1ce833b8d85bd8a6a8fda186a93a0bc504d45400810140002601014000370e90001b8748008dc3a40086e1d2038374a90001ba54800955cf2ab9d1\"}},{\"txHash\":\"cb78d0612a8a54e4cbe43c90e23dc7739f0b27fffbd7caa5368d9b98047601b1\",\"outputIndex\":0,\"address\":\"addr1wyvvjx7l749d3axnvxyp3umtn8jqrj48a2c48dp02yc3evqzypx02\",\"value\":{\"lovelace\":\"2267060\",\"assets\":{\"4d564c6e31f771d71471437ea9f0e60038be09619755f8720eb093cd.\":\"1\",\"9e3ca7a4d3ae25b02b1ce833b8d85bd8a6a8fda186a93a0bc504d454.\":\"1\",\"d30ee8c513b3fabada55d802a5ca5bb12e43b42027017309ed71ed4b.\":\"1\"}},\"datumHash\":\"671a25e519487eeb4a3ec3abf857d5f0f561edae50386966e456572541ac7451\",\"inlineDatum\":\"d8799f1b00002d79cfe23080ff\",\"referenceScript\":{\"type\":\"NativeScript\",\"script\":\"830304868200581cde4abaf30e894ec9243b8bb97ad7414b1d3086833ad8bf12d10130d08200581caf62c226e169c1fb4e84eb4286bac6bfda702ecf3a49f9fdbe5bf78f8200581cd8c1b4ad263333c687291894fb466a3bc1429565c2541e54b8901e158200581c5d5bbb9f55ea3524307dd6ed28e72b156f60ffc181cc20b89f2f13338200581cb6ee5605641b0f573312699348d19e71765d0010a4cac2c4fc9678178200581cde398fc701ce1b4adb7119d68c1d9710cfb70dec6989e31acc6d274f\"}},{\"txHash\":\"6153c1e9a628fc2bc1ebc82d1f6b6d360c3f5a895171cfd8a792541ab51f7509\",\"outputIndex\":1,\"address\":\"addr1q80y4whnp6y5ajfy8w9mj7khg9936vyxsvad30cj6yqnp5r2vrs4j05rcf6n6w8wvxpar47dkzsutjax2lre3zz3y2nqh3h7xa\",\"value\":{\"lovelace\":\"1784340\",\"assets\":{\"6ac8ef33b510ec004fe11585f7c5a9f0c07f0c23428ab4f29c1d7d10.4d454c44\":\"5000000\",\"a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235.484f534b59\":\"20250010\",\"a2944573e99d2ed3055b808eaa264f0bf119e01fc6b18863067c63e4.4d454c44\":\"15015000994000\",\"b06729158210bf1ba13f8f3d7d422a918d3eaa82561a705552a2568b.4d656c642042616e6b204d616e616765722076312033393937\":\"1\"}},\"datumHash\":null},{\"txHash\":\"6153c1e9a628fc2bc1ebc82d1f6b6d360c3f5a895171cfd8a792541ab51f7509\",\"outputIndex\":2,\"address\":\"addr1q80y4whnp6y5ajfy8w9mj7khg9936vyxsvad30cj6yqnp5r2vrs4j05rcf6n6w8wvxpar47dkzsutjax2lre3zz3y2nqh3h7xa\",\"value\":{\"lovelace\":\"445509838\"},\"datumHash\":null}]";
const PROTOCOL_PARAMS: &str = "{\"minFeeA\":155381,\"minFeeB\":44,\"maxTxSize\":16384,\"maxValSize\":\"5000\",\"keyDeposit\":\"2000000\",\"poolDeposit\":\"500000000\",\"minPoolCost\":\"170000000\",\"utxoCostPerWord\":0,\"maxTxExMem\":\"14000000\",\"maxTxExSteps\":\"10000000000\",\"maxBlockExMem\":\"62000000\",\"maxBlockExSteps\":\"20000000000\",\"maxCollateralInputs\":3,\"costModels\":{\"PlutusV1\":[100788,420,1,1,1000,173,0,1,1000,59957,4,1,11183,32,201305,8356,4,16000,100,16000,100,16000,100,16000,100,16000,100,16000,100,100,100,16000,100,94375,32,132994,32,61462,4,72010,178,0,1,22151,32,91189,769,4,2,85848,228465,122,0,1,1,1000,42921,4,2,24548,29498,38,1,898148,27279,1,51775,558,1,39184,1000,60594,1,141895,32,83150,32,15299,32,76049,1,13169,4,22100,10,28999,74,1,28999,74,1,43285,552,1,44749,541,1,33852,32,68246,32,72362,32,7243,32,7391,32,11546,32,85848,228465,122,0,1,1,90434,519,0,1,74433,32,85848,228465,122,0,1,1,85848,228465,122,0,1,1,270652,22588,4,1457325,64566,4,20467,1,4,0,141992,32,100788,420,1,1,81663,32,59498,32,20142,32,24588,32,20744,32,25933,32,24623,32,53384111,14333,10],\"PlutusV2\":[100788,420,1,1,1000,173,0,1,1000,59957,4,1,11183,32,201305,8356,4,16000,100,16000,100,16000,100,16000,100,16000,100,16000,100,100,100,16000,100,94375,32,132994,32,61462,4,72010,178,0,1,22151,32,91189,769,4,2,85848,228465,122,0,1,1,1000,42921,4,2,24548,29498,38,1,898148,27279,1,51775,558,1,39184,1000,60594,1,141895,32,83150,32,15299,32,76049,1,13169,4,22100,10,28999,74,1,28999,74,1,43285,552,1,44749,541,1,33852,32,68246,32,72362,32,7243,32,7391,32,11546,32,85848,228465,122,0,1,1,90434,519,0,1,74433,32,85848,228465,122,0,1,1,85848,228465,122,0,1,1,955506,213312,0,2,270652,22588,4,1457325,64566,4,20467,1,4,0,141992,32,100788,420,1,1,81663,32,59498,32,20142,32,24588,32,20744,32,25933,32,24623,32,43053543,10,53384111,14333,10,43574283,26308,10],\"PlutusV3\":[100788,420,1,1,1000,173,0,1,1000,59957,4,1,11183,32,201305,8356,4,16000,100,16000,100,16000,100,16000,100,16000,100,16000,100,100,100,16000,100,94375,32,132994,32,61462,4,72010,178,0,1,22151,32,91189,769,4,2,85848,123203,7305,-900,1716,549,57,85848,0,1,1,1000,42921,4,2,24548,29498,38,1,898148,27279,1,51775,558,1,39184,1000,60594,1,141895,32,83150,32,15299,32,76049,1,13169,4,22100,10,28999,74,1,28999,74,1,43285,552,1,44749,541,1,33852,32,68246,32,72362,32,7243,32,7391,32,11546,32,85848,123203,7305,-900,1716,549,57,85848,0,1,90434,519,0,1,74433,32,85848,123203,7305,-900,1716,549,57,85848,0,1,1,85848,123203,7305,-900,1716,549,57,85848,0,1,955506,213312,0,2,270652,22588,4,1457325,64566,4,20467,1,4,0,141992,32,100788,420,1,1,81663,32,59498,32,20142,32,24588,32,20744,32,25933,32,24623,32,43053543,10,53384111,14333,10,43574283,26308,10,16000,100,16000,100,962335,18,2780678,6,442008,1,52538055,3756,18,267929,18,76433006,8868,18,52948122,18,1995836,36,3227919,12,901022,1,166917843,4307,36,284546,36,158221314,26549,36,74698472,36,333849714,1,254006273,72,2174038,72,2261318,64571,4,207616,8310,4,1293828,28716,63,0,1,1006041,43623,251,0,1,100181,726,719,0,1,100181,726,719,0,1,100181,726,719,0,1,107878,680,0,1,95336,1,281145,18848,0,1,180194,159,1,1,158519,8942,0,1,159378,8813,0,1,107490,3298,1,106057,655,1,1964219,24520,3]},\"protocolVersion\":{\"major\":10,\"minor\":0}}";

/// A fresh debug session on the fixture's `Spend:2` redeemer. Every call re-parses the program, so
/// two sessions share no term ids — which is what makes the "same outcome as a plain run" test a
/// comparison of two independent runs and not of one run with itself.
fn fixture_session() -> SessionController {
    let mut engine = DebuggerEngine::new(TX_HEX, UTXO_JSON, PROTOCOL_PARAMS, "mainnet").unwrap();
    engine.init_debug_session("Spend:2").unwrap()
}

#[test]
fn open_test() {
    let session = fixture_session();
    let _script = session.get_script().unwrap();
}

/// accounting invariants on the real fixture. Every unit the machine spends has to land in exactly one term
/// node AND in exactly one builtin-or-step row, and our per-step accounting has to agree with the
/// machine's own `spend_counter` — the counter is the independent witness, which is the only reason
/// the attribution loop can be trusted at all.
#[test]
fn profile_accounting_invariants() {
    let mut session = fixture_session();
    session.profile_start().unwrap();
    // One chunk for the whole program: max_steps bounds the chunk, and the host's own cap is what
    // normally stops a run early.
    let chunk: ProfileRunResult =
        serde_json::from_str(&session.profile_run(u32::MAX).unwrap()).unwrap();
    assert_ne!(chunk.outcome, ProfileRunOutcome::Running, "the run must have ended");

    let profile: SerializableProfile =
        serde_json::from_str(&session.profile_report().unwrap()).unwrap();
    let totals = &profile.totals;
    assert_eq!(chunk.steps, totals.steps);
    assert_eq!(chunk.cpu, totals.cpu_spent);
    assert_eq!(chunk.mem, totals.mem_spent);
    // A session profiles under v2. The invariants below are the ones the attribution rule is
    // NOT allowed to change: it moves cost between nodes, it never creates or loses any.
    assert_eq!(totals.attribution, ProfileAttribution::ApplySite);

    // Σ terms.self + startup == image − final, Σ builtins + Σ steps == the same total, Σ hits == steps.
    assert_profile_invariants(&profile);
    let builtin_cpu: i64 = profile.builtins.iter().map(|row| row.cpu).sum();
    let step_cpu: i64 = profile.steps.iter().map(|row| row.cpu).sum();
    assert!(builtin_cpu > 0 && step_cpu > 0, "the fixture exercises both sides of that split");

    // The steps[] we counted step by step == the machine's own `spend_counter` prefix, kind by kind.
    let counter = session
        .profile_runner()
        .unwrap()
        .machine()
        .spend_counter
        .expect("the profile machine is built with new_debug");
    assert_eq!(profile.steps.len(), TERM_COUNT + 1, "nine machine step kinds plus StartUp");
    for (i, row) in profile.steps.iter().take(TERM_COUNT).enumerate() {
        assert_eq!(row.mem, counter[i * 2], "mem of step kind {}", row.kind);
        assert_eq!(row.cpu, counter[i * 2 + 1], "cpu of step kind {}", row.kind);
    }
    let startup = profile.steps.last().unwrap();
    assert_eq!(startup.kind, "StartUp");
    assert_eq!((startup.cpu, startup.mem), (totals.startup_cpu, totals.startup_mem));

    // ... and the builtin rows against theirs, so neither side of the split is self-certified.
    let counted_builtin_cpu: i64 = counter
        .iter()
        .skip(TERM_COUNT * 2 + 1)
        .step_by(2)
        .sum();
    assert_eq!(builtin_cpu, counted_builtin_cpu, "builtin cpu vs spend_counter");

    // Subtree aggregation covers every executed node exactly once: the entry term's subtree is the
    // whole run minus the startup charge. `get_current_term_id` still names the root here — the
    // debug session has not stepped, and the profiler never touches it.
    let root = session.get_current_term_id().unwrap();
    let root_row = profile
        .terms
        .iter()
        .find(|row| row.term_id == root)
        .expect("the entry term ran");
    let located_self: i64 = profile
        .terms
        .iter()
        .filter(|row| row.term_id >= 0)
        .map(|row| row.self_cpu)
        .sum();
    assert_eq!(root_row.total_cpu, located_self, "root subtree == Σ self over the AST");

    // ... and it holds at EVERY node, not only at the root: the root equality above balances even
    // if a whole branch's costs were charged one level too high, because the sum is the same.
    assert_subtree_closure(&profile, session.entry_term());

    assert!(totals.cpu_limit.is_some(), "a tx-derived session has declared ExUnits");
    assert!(!profile.timeline.is_empty());
}

/// The profiled run has to end where a plain run of the same program ends — same outcome, same
/// units — because the profiler runs its own machine and could otherwise drift from the debugger
/// the user is looking at. Two independent sessions: one profiled, one stepped.
#[test]
fn profile_matches_a_plain_run() {
    let mut profiled = fixture_session();
    profiled.profile_start().unwrap();
    profiled.profile_run(u32::MAX).unwrap();
    let profile: SerializableProfile =
        serde_json::from_str(&profiled.profile_report().unwrap()).unwrap();

    let mut plain = fixture_session();
    let plain_status = loop {
        let result: serde_json::Value = serde_json::from_str(&plain.step().unwrap()).unwrap();
        let status = result["status"]["status_type"].as_str().unwrap().to_string();
        if status != "Ready" {
            break status;
        }
    };
    let budget: SerializableBudget = serde_json::from_str(&plain.get_budget().unwrap()).unwrap();

    match (&profile.totals.outcome, plain_status.as_str()) {
        (ProfileOutcome::Done, "Done") => {}
        (ProfileOutcome::Error { .. }, "Error") => {}
        (profiled_outcome, plain_outcome) => panic!(
            "profiled run ended as {:?}, the plain run as {}",
            profiled_outcome, plain_outcome
        ),
    }
    assert_eq!(profile.totals.cpu_spent, budget.ex_units_spent, "cpu spent");
    assert_eq!(profile.totals.mem_spent, budget.memory_units_spent, "mem spent");
}

/// A program that actually traces — the tx fixture's validator emits nothing, and an empty log is
/// no evidence at all for the test below.
const TRACE_PROGRAM: &str =
    r#"(program 1.0.0 [ (force (builtin trace)) (con string "profiled") (con integer 42) ])"#;

/// `ProfileRunner` owns its `ManualMachine`, and `traces` is a FIELD of the machine
/// — that is the entire reason for the second machine, and this is the test that holds it to it.
/// The profile run DOES emit a trace here, into its own buffer; the debug session's log has to come
/// out byte-for-byte unchanged, and then log its own run exactly as a session that was never
/// profiled does — so neither stealing the traces nor injecting the profile's own can pass.
/// A script that traces per iteration is otherwise unbounded: the machine's `traces` is a plain
/// `Vec` it appends to forever, and the report copies all of it. The cap keeps the first
/// `TRACE_CAP` and counts the rest — measured, this is the difference between a 7.3 MB report and
/// a 0.8 MB one on a 100k-iteration loop.
#[test]
fn a_trace_heavy_run_is_capped_and_says_how_much_it_dropped() {
    // 20 000 iterations, one trace each — comfortably past the 10 000 cap.
    let src = r#"(program 1.0.0 [ (lam f [ (lam x [ f (lam v [ x x v ]) ]) (lam x [ f (lam v [ x x v ]) ]) ])
      (lam rec (lam n (force [ (force (builtin ifThenElse))
          [ (builtin lessThanEqualsInteger) n (con integer 0) ]
          (delay (con integer 0))
          (delay [ rec [ (builtin subtractInteger) [ [ (force (builtin trace)) (con string "tick") ] n ] (con integer 1) ] ]) ])))
      (con integer 20000) ])"#;
    let mut session = new_session_from_program(src, "V3").unwrap();
    session.profile_start().unwrap();
    while serde_json::from_str::<ProfileRunResult>(&session.profile_run(5_000_000).unwrap())
        .unwrap()
        .outcome
        == ProfileRunOutcome::Running
    {}
    let profile: SerializableProfile =
        serde_json::from_str(&session.profile_report().unwrap()).unwrap();

    assert_eq!(profile.traces.len(), 10_000, "kept exactly the cap");
    assert_eq!(
        profile.traces.len() as u64 + profile.traces_dropped,
        20_000,
        "kept + dropped accounts for every trace the run emitted"
    );
    // The prefix is the useful part: the kept traces are the FIRST ones, in order.
    assert_eq!(profile.traces[0].index, 0);
    assert_eq!(profile.traces[9_999].index, 9_999);
    // Capping the log must not disturb the accounting.
    assert_profile_invariants(&profile);
}

#[test]
fn profile_leaves_the_debug_session_log_untouched() {
    let mut session = new_session_from_program(TRACE_PROGRAM, "V3").unwrap();
    let before = session.get_logs().unwrap();
    assert_eq!(before, "[]", "nothing is logged before the session runs");

    session.profile_start().unwrap();
    session.profile_run(u32::MAX).unwrap();
    let profile: SerializableProfile =
        serde_json::from_str(&session.profile_report().unwrap()).unwrap();

    // The profile did trace, into its own buffer, and marked the node and the step it happened on.
    assert_eq!(profile.traces.len(), 1, "the profiled run traced exactly once");
    assert_eq!(profile.traces[0].message, "profiled");
    assert!(profile.traces[0].term_id >= 0 && profile.traces[0].step > 0);

    assert_eq!(session.get_logs().unwrap(), before, "get_logs() across a profile run");

    let profiled_then_run = run_to_end_logs(&mut session);
    let never_profiled = run_to_end_logs(&mut new_session_from_program(TRACE_PROGRAM, "V3").unwrap());
    assert_eq!(profiled_then_run, r#"["profiled"]"#, "and the session logs its own run");
    assert_eq!(profiled_then_run, never_profiled);
}

// ── declared ExUnits (the parts deep-link) ───────────────────────────────────
//
// A shared "parts" link carries the redeemer's Data ARGUMENT but not the ExUnits its witness
// declared — those live in the transaction's witness set and are derivable from nothing in the
// link. `ex_units` is how a generator hands them over; a session that was given none must report
// none, because the alternative (a share of `ExBudget::default()`) reads as a real budget.

/// A program small enough that the run is beside the point — these tests are about the numbers the
/// session DECLARES, not the ones it spends.
const TINY_PROGRAM: &str = "(program 1.1.0 (con integer 42))";

/// A parts session over `TINY_PROGRAM`, with `ex_units` set to the given JSON (or absent).
fn parts_session(ex_units: Option<serde_json::Value>) -> SessionController {
    let mut cfg = serde_json::json!({ "script": TINY_PROGRAM, "language": "V3" });
    if let Some(v) = ex_units {
        cfg["ex_units"] = v;
    }
    new_session_from_parts(&cfg.to_string()).expect("a parts config always opens")
}

/// `(cpu_limit, mem_limit)` from the profile and `(cpu, mem)` available from the budget — the two
/// surfaces that quote a limit, which have to agree about whether there is one.
fn declared_limits(session: &mut SessionController) -> ((Option<i64>, Option<i64>), (Option<i64>, Option<i64>)) {
    session.profile_start().unwrap();
    session.profile_run(u32::MAX).unwrap();
    let profile: SerializableProfile =
        serde_json::from_str(&session.profile_report().unwrap()).unwrap();
    let budget: SerializableBudget = serde_json::from_str(&session.get_budget().unwrap()).unwrap();
    (
        (profile.totals.cpu_limit, profile.totals.mem_limit),
        (budget.ex_units_available, budget.memory_units_available),
    )
}

#[test]
fn parts_ex_units_are_the_declared_limit() {
    let mut session = parts_session(Some(serde_json::json!([8_177_555, 25_305])));
    let (profile, budget) = declared_limits(&mut session);
    assert_eq!(profile, (Some(8_177_555), Some(25_305)), "profile totals");
    assert_eq!(budget, (Some(8_177_555), Some(25_305)), "budget panel");
}

#[test]
fn parts_without_ex_units_declare_no_limit() {
    let mut session = parts_session(None);
    let (profile, budget) = declared_limits(&mut session);
    assert_eq!(profile, (None, None), "no ex_units in the link, no limit in the profile");
    assert_eq!(budget, (None, None), "…and none in the budget either");
}

/// Every one of these is a link somebody would still expect to open. Losing the declared limit is
/// the whole cost of getting `ex_units` wrong; failing to open is not on the table.
#[test]
fn a_malformed_ex_units_is_ignored_not_fatal() {
    for malformed in [
        serde_json::json!([8_177_555]),                 // one number: which one?
        serde_json::json!([8_177_555, 25_305, 1]),      // three
        serde_json::json!([]),                          // none
        serde_json::json!([-1, 25_305]),                // negative cpu
        serde_json::json!([8_177_555, -25_305]),        // negative mem
        serde_json::json!([1.5, 2.5]),                  // not integers
        serde_json::json!(["8177555", "25305"]),        // strings
        serde_json::json!("8177555,25305"),             // the URL form, not decoded
        serde_json::json!({ "cpu": 8_177_555 }),        // an object
        serde_json::json!(null),
    ] {
        let mut session = parts_session(Some(malformed.clone()));
        let (profile, budget) = declared_limits(&mut session);
        assert_eq!(profile, (None, None), "profile limit for ex_units = {malformed}");
        assert_eq!(budget, (None, None), "budget limit for ex_units = {malformed}");
    }
}

/// A bare UPLC program has no redeemer and no link to carry one — it declares nothing either.
#[test]
fn a_bare_program_declares_no_limit() {
    let mut session = new_session_from_program(TINY_PROGRAM, "V3").unwrap();
    let (profile, budget) = declared_limits(&mut session);
    assert_eq!(profile, (None, None));
    assert_eq!(budget, (None, None));
}

/// The tx path still declares the redeemer's own ExUnits — the fixture's `Spend:2` witness.
#[test]
fn a_tx_session_declares_the_redeemers_ex_units() {
    let budget: SerializableBudget =
        serde_json::from_str(&fixture_session().get_budget().unwrap()).unwrap();
    // `840002d87980821a0004bd501a07f45cee` in the witness set: ex_units = [mem, steps].
    assert_eq!(budget.ex_units_available, Some(133_455_086));
    assert_eq!(budget.memory_units_available, Some(310_608));
}

// ── v2 attribution ───────────────────────────────────────────────────────────
//
// Hand-built programs from here down: the point of these tests is "the cost landed on THAT node",
// which is only a statement worth making when every node id is written out in this file.

/// `[[(builtin addInteger) (con integer 2)] (con integer 3)]`.
///
/// The addInteger fires on the Return step that consumes the OUTER apply's frame, and the last term
/// the machine actually computed by then is `(con integer 3)` — so v1 charges a builtin to the node
/// of its own argument. That is the whole reason v2 exists.
fn add_program() -> Term<NamedDeBruijn> {
    Term::Apply {
        uniq_id: 0,
        function: Term::Apply {
            uniq_id: 1,
            function: Term::Builtin { fun: DefaultFunction::AddInteger, uniq_id: 2 }.into(),
            argument: Term::Constant { value: Constant::Integer(2.into()).into(), uniq_id: 3 }.into(),
        }
        .into(),
        argument: Term::Constant { value: Constant::Integer(3.into()).into(), uniq_id: 4 }.into(),
    }
}

/// The same program with its second argument replaced by
/// `(case (constr 0 [(con integer 10), (con integer 20)]) (builtin addInteger))`, which is the ONE
/// shape that puts frames on the machine's application stack that no `Term::Apply` opened
/// (`transfer_arg_stack`). Without it the shadow stack would never be exercised out of lockstep.
fn case_program() -> Term<NamedDeBruijn> {
    Term::Apply {
        uniq_id: 0,
        function: Term::Apply {
            uniq_id: 1,
            function: Term::Builtin { fun: DefaultFunction::AddInteger, uniq_id: 2 }.into(),
            argument: Term::Constant { value: Constant::Integer(2.into()).into(), uniq_id: 3 }.into(),
        }
        .into(),
        argument: Term::Case {
            uniq_id: 5,
            constr: Term::Constr {
                tag: 0,
                fields: vec![
                    Term::Constant { value: Constant::Integer(10.into()).into(), uniq_id: 6 },
                    Term::Constant { value: Constant::Integer(20.into()).into(), uniq_id: 7 },
                ],
                uniq_id: 8,
            }
            .into(),
            branches: vec![Term::Builtin { fun: DefaultFunction::AddInteger, uniq_id: 9 }],
        }
        .into(),
    }
}

/// Same program, same run, two attribution rules. Totals, builtins
/// and step kinds are IDENTICAL (v2 moves cost between nodes, it never creates or loses any); what
/// moves is which node the builtin's cost is charged to.
#[test]
fn v1_and_v2_differ_only_in_where_return_cost_lands() {
    let term = add_program();
    let v1 = profile_of(&term, ProfileAttribution::LastTerm);
    let v2 = profile_of(&term, ProfileAttribution::ApplySite);

    assert_eq!(v1.totals.attribution, ProfileAttribution::LastTerm);
    assert_eq!(v2.totals.attribution, ProfileAttribution::ApplySite);
    for profile in [&v1, &v2] {
        assert_profile_invariants(profile);
        assert_subtree_closure(profile, &term);
        assert!(matches!(profile.totals.outcome, ProfileOutcome::Done));
    }

    // Everything that is not per-node attribution is the same run.
    assert_same_run(&v1, &v2);

    let add = &v1.builtins[0];
    assert_eq!((add.name.as_str(), add.calls), ("addInteger", 1), "one builtin, called once");
    assert!(add.cpu > 0);

    // v1: the builtin's cost sits on `(con integer 3)` — the ARGUMENT node, which is merely the last
    // thing the machine computed before the application happened.
    assert_eq!(row(&v1, 4).return_cpu, add.cpu, "v1 charges the argument node");
    assert_eq!(row(&v1, 0).return_cpu, 0, "v1 charges the apply site nothing");

    // v2: it sits on the apply site the Return step returns into, and nothing else moved — the two
    // rows differ by exactly the builtin's cost, in both directions.
    assert_eq!(row(&v2, 0).return_cpu, add.cpu, "v2 charges the apply site");
    assert_eq!(row(&v2, 4).return_cpu, 0, "v2 charges the argument node nothing");
    assert_eq!(row(&v2, 0).self_cpu, row(&v1, 0).self_cpu + add.cpu);
    assert_eq!(row(&v2, 4).self_cpu, row(&v1, 4).self_cpu - add.cpu);
    assert_eq!(row(&v2, 0).self_mem, row(&v1, 0).self_mem + add.mem);

    // And the `≈` predicate the UI draws from this (`return_cpu / self_cpu >= 0.5`): under v1 the
    // constant's row is return-dominated — a "hot" `(con integer 3)` that never cost anything — and
    // under v2 there is nothing left on it to mark.
    assert!(row(&v1, 4).return_cpu * 2 >= row(&v1, 4).self_cpu, "v1 row is return-dominated");
    assert_eq!(row(&v2, 4).return_cpu, 0);
}

/// The same comparison on the e2e fixture instead of a hand-built term: a real validator, thousands
/// of steps, both rules. Every total matches to the unit — and the per-node split does not: on this
/// program v1 spreads 69 M cpu of builtin cost over Vars, Constants and Delays, v2 puts all of it on
/// the applications that fired those builtins.
#[test]
fn v1_and_v2_agree_on_every_total_of_the_real_fixture() {
    let session = fixture_session();
    let entry = session.entry_term();
    let v1 = profile_of(entry, ProfileAttribution::LastTerm);
    let v2 = profile_of(entry, ProfileAttribution::ApplySite);

    for profile in [&v1, &v2] {
        assert_profile_invariants(profile);
        assert_subtree_closure(profile, entry);
    }
    assert_same_run(&v1, &v2);

    // The rule really moves cost — on this fixture, a lot of it.
    let self_of = |profile: &SerializableProfile| {
        profile.terms.iter().map(|row| (row.term_id, row.self_cpu)).collect::<HashMap<_, _>>()
    };
    let (before, after) = (self_of(&v1), self_of(&v2));
    let moved: i64 = before
        .iter()
        .map(|(id, cpu)| (cpu - after.get(id).copied().unwrap_or(0)).abs())
        .sum();
    assert!(moved > 0, "v2 has to charge somebody differently or it is not a second rule");

    // And WHERE it moves is the whole argument for v2. Return cost is builtin cost (see the Σ return
    // == Σ builtin invariant), so the kinds of node carrying it say which rule is telling the truth:
    // v1 spreads every builtin over Vars, Constants and Delays — the argument that happened to be
    // computed last, never the application itself — while v2 puts all of it on apply sites.
    // (On a fixture with `case`, v2 would also fall back to v1 for the applications the machine
    // synthesises out of a constr; this V2 validator has none, so the set here is exactly `Apply`.)
    let mut kinds = HashMap::new();
    collect_kinds(entry, &mut kinds);
    let carriers = |profile: &SerializableProfile| {
        profile
            .terms
            .iter()
            .filter(|row| row.return_cpu > 0)
            .map(|row| kinds.get(&row.term_id).copied().unwrap_or("<no node>"))
            .collect::<HashSet<_>>()
    };
    assert_eq!(carriers(&v2), HashSet::from(["Apply"]), "v2 charges apply sites, and only those");
    assert!(!carriers(&v1).contains("Apply"), "v1 never charges the application itself");
    assert!(carriers(&v1).contains("Var"), "v1 charges builtins to the arguments they consumed");
}

/// The shadow stack is only worth anything if it really mirrors the machine, so this walks a program
/// that mixes both kinds of application frame one step at a time and pins the two against each other
/// after EVERY step: `Some` where a source `Term::Apply` is pending, `None` where the machine
/// synthesised an application out of a `case` — and nothing else, in exactly that order.
#[test]
fn the_apply_site_stack_mirrors_the_machines_frames() {
    let term = case_program();
    let mut runner = runner_for(&term, ProfileAttribution::ApplySite);

    let mut step = 0;
    loop {
        // `collect_nested_contexts` runs innermost-first; the shadow stack is innermost-LAST.
        let frames: Vec<bool> = runner
            .machine()
            .collect_nested_contexts()
            .iter()
            .rev()
            .filter_map(|context| match context {
                Context::FrameAwaitFunTerm(_, _, _) | Context::FrameAwaitArg(_, _) => Some(true),
                Context::FrameAwaitFunValue(_, _) => Some(false),
                _ => None,
            })
            .collect();
        let shadow: Vec<bool> = runner.apply_stack().iter().map(|site| site.is_some()).collect();
        assert_eq!(shadow, frames, "apply-site stack vs machine frames after step {step}");

        if runner.run_chunk(1).outcome != ProfileRunOutcome::Running {
            break;
        }
        step += 1;
        assert!(step < 200, "the fixture must terminate");
    }
    // Both applications the `case` synthesised were consumed, and so was every source apply site.
    assert!(runner.apply_stack().is_empty(), "no frame outlives the run");

    // The case-transferred applications have no source node, so v2 keeps v1's site for them rather
    // than borrowing the enclosing apply's — the invariants have to survive that fallback too.
    let profile = runner.report(&term, None, None);
    assert_profile_invariants(&profile);
    assert_subtree_closure(&profile, &term);

    // Both addIntegers fire on a Return step, and they land on different kinds of site: the one that
    // consumes the outer apply's frame goes to that apply site (#0), the one the `case` synthesised
    // has no apply site at all and falls back to v1 — the branch's own builtin node (#9).
    let add = &profile.builtins[0];
    assert_eq!((add.name.as_str(), add.calls), ("addInteger", 2));
    assert!(row(&profile, 0).return_cpu > 0, "the source apply site carries its builtin");
    assert!(row(&profile, 9).return_cpu > 0, "the case-synthesised application fell back to v1");
    assert_eq!(row(&profile, 0).return_cpu + row(&profile, 9).return_cpu, add.cpu);
}

// ── Shared assertions ─────────────────────────────────────────────────────────────

/// The accounting invariants, in one place because they must hold under EVERY attribution rule: a rule
/// decides which node a step's cost lands on, never how much there is.
fn assert_profile_invariants(profile: &SerializableProfile) {
    let totals = &profile.totals;

    // Σ terms.self + startup == image − final. StartUp is charged in `ManualMachine::new` and
    // belongs to no node, so it is the only part of the total the nodes do not carry.
    let self_cpu: i64 = profile.terms.iter().map(|row| row.self_cpu).sum();
    let self_mem: i64 = profile.terms.iter().map(|row| row.self_mem).sum();
    assert_eq!(self_cpu + totals.startup_cpu, totals.cpu_spent, "node self cpu + startup");
    assert_eq!(self_mem + totals.startup_mem, totals.mem_spent, "node self mem + startup");

    // Σ builtins + Σ steps == the same total. This is the equality the report renders as
    // "machine X% + builtins Y% = 100%", and StartUp is inside the steps side of it.
    let builtin_cpu: i64 = profile.builtins.iter().map(|row| row.cpu).sum();
    let builtin_mem: i64 = profile.builtins.iter().map(|row| row.mem).sum();
    let step_cpu: i64 = profile.steps.iter().map(|row| row.cpu).sum();
    let step_mem: i64 = profile.steps.iter().map(|row| row.mem).sum();
    assert_eq!(builtin_cpu + step_cpu, totals.cpu_spent, "builtins + steps cpu");
    assert_eq!(builtin_mem + step_mem, totals.mem_spent, "builtins + steps mem");

    // Every counted step increments exactly one node's hits, whichever node the rule picked.
    let hits: u64 = profile.terms.iter().map(|row| row.hits).sum();
    assert_eq!(hits, totals.steps, "Σ hits == steps");

    // A row's return part is part of its self, not a second number beside it.
    for row in &profile.terms {
        assert!(row.return_cpu <= row.self_cpu, "return cpu of #{}", row.term_id);
        assert!(row.return_mem <= row.self_mem, "return mem of #{}", row.term_id);
    }

    // Σ return == Σ builtins, exactly: at slippage 1 a Compute step charges its own step kind and
    // nothing else, and a builtin can only fire out of `return_compute`. So the return part of the
    // report IS the builtin part, redistributed over nodes — which is why the `≈` marker reads as
    // "this row is mostly somebody else's builtin" under v1.
    let return_cpu: i64 = profile.terms.iter().map(|row| row.return_cpu).sum();
    let return_mem: i64 = profile.terms.iter().map(|row| row.return_mem).sum();
    assert_eq!(return_cpu, builtin_cpu, "Σ return cpu == Σ builtin cpu");
    assert_eq!(return_mem, builtin_mem, "Σ return mem == Σ builtin mem");
}

/// Everything two profiles of the SAME program under different attribution rules must agree on. An
/// attribution rule decides which node a step's cost lands on; the run, its builtins and its machine
/// steps are the same run either way.
fn assert_same_run(a: &SerializableProfile, b: &SerializableProfile) {
    assert_eq!(a.totals.steps, b.totals.steps, "steps");
    assert_eq!(a.totals.cpu_spent, b.totals.cpu_spent, "cpu spent");
    assert_eq!(a.totals.mem_spent, b.totals.mem_spent, "mem spent");
    let builtins = |p: &SerializableProfile| {
        p.builtins.iter().map(|r| (r.name.clone(), r.calls, r.cpu, r.mem)).collect::<Vec<_>>()
    };
    let steps = |p: &SerializableProfile| {
        p.steps.iter().map(|r| (r.kind.clone(), r.count, r.cpu, r.mem)).collect::<Vec<_>>()
    };
    assert_eq!(builtins(a), builtins(b), "builtins");
    assert_eq!(steps(a), steps(b), "step kinds");
}

/// `total == self + Σ children.total` at EVERY node (the acceptance tests), walked over the AST the report
/// was built from. The root equality alone cannot catch a subtree charged one level too high — the
/// sum over the whole tree is the same either way.
fn assert_subtree_closure(profile: &SerializableProfile, entry_term: &Term<NamedDeBruijn>) {
    let rows: HashMap<i32, &ProfileTerm> =
        profile.terms.iter().map(|row| (row.term_id, row)).collect();
    let mut pending = vec![entry_term];
    while let Some(term) = pending.pop() {
        let id = term.uniq_id() as i32;
        let children = child_terms(term);
        match rows.get(&id) {
            Some(row) => {
                let mut cpu = row.self_cpu;
                let mut mem = row.self_mem;
                for child in &children {
                    if let Some(child_row) = rows.get(&(child.uniq_id() as i32)) {
                        cpu += child_row.total_cpu;
                        mem += child_row.total_mem;
                    }
                }
                assert_eq!(row.total_cpu, cpu, "subtree cpu of #{id}");
                assert_eq!(row.total_mem, mem, "subtree mem of #{id}");
            }
            // A node is reachable only through its parent, so a node with no row can have nothing
            // under it. If it could, its descendants' cost would be missing from every ancestor's
            // total and the equality above would still balance.
            None => assert!(
                children.iter().all(|child| !rows.contains_key(&(child.uniq_id() as i32))),
                "#{id} never ran, but something under it did",
            ),
        }
        pending.extend(children);
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────────

fn row(profile: &SerializableProfile, term_id: i32) -> &ProfileTerm {
    profile
        .terms
        .iter()
        .find(|row| row.term_id == term_id)
        .unwrap_or_else(|| panic!("#{term_id} did not run"))
}

/// A runner over a hand-built program — no transaction, no session, no redeemer (hence no declared
/// limits in the report).
fn runner_for(term: &Term<NamedDeBruijn>, attribution: ProfileAttribution) -> ProfileRunner {
    let mut ids = HashSet::new();
    collect_ids(term, &mut ids);
    ProfileRunner::new(Language::PlutusV2, CostModel::default(), term, &ids, attribution)
        .expect("the profile machine is built from the entry term")
}

fn profile_of(term: &Term<NamedDeBruijn>, attribution: ProfileAttribution) -> SerializableProfile {
    let mut runner = runner_for(term, attribution);
    let result = runner.run_chunk(u32::MAX);
    assert_ne!(result.outcome, ProfileRunOutcome::Running, "the run must have ended");
    runner.report(term, None, None)
}

fn child_terms(term: &Term<NamedDeBruijn>) -> Vec<&Term<NamedDeBruijn>> {
    match term {
        Term::Delay { body, .. } | Term::Lambda { body, .. } | Term::Force { body, .. } => {
            vec![body.as_ref()]
        }
        Term::Apply { function, argument, .. } => vec![function.as_ref(), argument.as_ref()],
        Term::Constr { fields, .. } => fields.iter().collect(),
        Term::Case { constr, branches, .. } => {
            let mut out = vec![constr.as_ref()];
            out.extend(branches.iter());
            out
        }
        Term::Var { .. } | Term::Constant { .. } | Term::Error { .. } | Term::Builtin { .. } => {
            vec![]
        }
    }
}

/// Node id → the term variant's name, so a test can say "this cost landed on a Var" about a program
/// nobody wrote by hand.
fn collect_kinds(term: &Term<NamedDeBruijn>, out: &mut HashMap<i32, &'static str>) {
    let kind = match term {
        Term::Var { .. } => "Var",
        Term::Delay { .. } => "Delay",
        Term::Lambda { .. } => "Lambda",
        Term::Apply { .. } => "Apply",
        Term::Constant { .. } => "Constant",
        Term::Force { .. } => "Force",
        Term::Error { .. } => "Error",
        Term::Builtin { .. } => "Builtin",
        Term::Constr { .. } => "Constr",
        Term::Case { .. } => "Case",
    };
    out.insert(term.uniq_id() as i32, kind);
    for child in child_terms(term) {
        collect_kinds(child, out);
    }
}

fn collect_ids(term: &Term<NamedDeBruijn>, out: &mut HashSet<i32>) {
    out.insert(term.uniq_id() as i32);
    for child in child_terms(term) {
        collect_ids(child, out);
    }
}

// ── the purpose a parts deep-link implies ────────────────────────────────────
//
// A "parts" link carries a context, and the context names the ScriptPurpose. Reading it needs no
// transaction, so a link opened from cquisitor can say what the script is being run for instead of
// printing a dash. What must NOT happen is reporting a purpose for Data that merely looks the part.

/// A context that is valid PlutusData but not a ScriptContext has no purpose to report — and must
/// not take the session down on the way to finding that out.
#[test]
fn an_ordinary_datum_is_not_mistaken_for_a_script_context() {
    // `Constr 3 [_, Constr 1 []]` is an unremarkable Aiken datum. Arity alone would read a purpose
    // off it and make the Session panel assert "Spending" about a session that has none.
    for ctx_hex in [
        "d87c9f40d87a80ff",   // Constr 3 [bytes, Constr 1 []]  → V1/V2 arity, wrong outer index
        "d87e9f4040d87d80ff", // Constr 5 [bytes, bytes, Constr 4 []] → V3 arity, wrong outer index
    ] {
        let cfg = serde_json::json!({
            "script": "(program 1.0.0 (con integer 1))", "language": "V2", "context": ctx_hex,
        });
        let session = new_session_from_parts(&cfg.to_string()).unwrap();
        assert_eq!(
            session.get_script_purpose().unwrap(), "",
            "context {ctx_hex} is not a ScriptContext and must name no purpose",
        );
    }
}

#[test]
fn a_non_string_purpose_loses_the_label_not_the_link() {
    // Same contract as a malformed `ex_units`: the link still opens.
    let cfg = serde_json::json!({
        "script": "(program 1.0.0 (con integer 1))", "language": "V2", "purpose": 123,
    });
    let session = new_session_from_parts(&cfg.to_string())
        .expect("a non-string purpose must not abort the config parse");
    assert_eq!(session.get_script_purpose().unwrap(), "");
}

/// Tx mode reads it off the typed `ScriptContext` instead — the same six names, one of which the
/// e2e fixture's `Spend:2` redeemer is.
#[test]
fn a_tx_session_names_its_purpose_too() {
    assert_eq!(fixture_session().get_script_purpose().unwrap(), "Spending");
}

/// Steps a session to completion and returns its log, as `get_logs()` serialises it.
fn run_to_end_logs(session: &mut SessionController) -> String {
    loop {
        let result: serde_json::Value = serde_json::from_str(&session.step().unwrap()).unwrap();
        if result["status"]["status_type"].as_str().unwrap() != "Ready" {
            break;
        }
    }
    session.get_logs().unwrap()
}

fn every_variant_term() -> crate::serializer::SerializableTerm {
    use crate::serializer::{SerializableConstant, SerializableTerm};
    SerializableTerm::Case {
        id: 1,
        constr: Box::new(SerializableTerm::Constr {
            id: 2,
            constructor_tag: 7,
            fields: vec![
                SerializableTerm::Var { id: 3, name: "x\"quoted\\".to_string() },
                SerializableTerm::Error { id: 4 },
                SerializableTerm::Builtin { id: 5, fun: "AddInteger".to_string() },
            ],
        }),
        branches: vec![
            SerializableTerm::Apply {
                id: 6,
                function: Box::new(SerializableTerm::Lambda {
                    id: 7,
                    parameter_name: "i_0".to_string(),
                    body: Box::new(SerializableTerm::Delay {
                        id: 8,
                        term: Box::new(SerializableTerm::Force {
                            id: 9,
                            term: Box::new(SerializableTerm::Constant {
                                id: 10,
                                constant: SerializableConstant::Integer { value: "42".to_string() },
                            }),
                        }),
                    }),
                }),
                argument: Box::new(SerializableTerm::Constant {
                    id: 11,
                    constant: SerializableConstant::Unit,
                }),
            },
            SerializableTerm::Constr { id: 12, constructor_tag: 0, fields: vec![] },
        ],
    }
}

#[test]
fn serialize_to_json_matches_serde() {
    let term = every_variant_term();
    assert_eq!(term.to_json().unwrap(), serde_json::to_string(&term).unwrap());
}

#[test]
fn deep_term_builds_serializes_and_drops_without_overflow() {
    use std::rc::Rc;
    use uplc::ast::Term;

    const DEPTH: usize = 200_000;

    let mut term: Term<NamedDeBruijn> = Term::Error { uniq_id: 0 };
    for i in 1..=DEPTH {
        term = Term::Delay { body: Rc::new(term), uniq_id: i as isize };
    }

    let serializable = crate::serializer::SerializableTerm::from_uplc_term(&term);
    let json = serializable.to_json().unwrap();

    assert_eq!(json.matches(r#""term_type":"Delay""#).count(), DEPTH);
    assert_eq!(json.matches(r#""term_type":"Error""#).count(), 1);

    drop(serializable);
}
