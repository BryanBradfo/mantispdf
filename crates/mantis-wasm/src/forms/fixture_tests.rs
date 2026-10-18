//! The committed e2e fixtures (`scripts/make-form-fixtures.py`) read as the
//! e2e specs expect.

use super::fill::fill_form;
use super::{FieldKind, Value, Xfa, list_form};

fn fixture(name: &str) -> Vec<u8> {
    let path = format!("{}/../../e2e/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

#[test]
fn form_fixture_fields() {
    let info = list_form(&fixture("form.pdf")).unwrap();
    assert_eq!(info.xfa, Xfa::None);
    let summary: Vec<(u32, &str, &str, u32)> = info
        .fields
        .iter()
        .map(|f| (f.id, f.name.as_str(), f.label.as_str(), f.widgets[0].page))
        .collect();
    assert_eq!(summary, vec![
        (0, "full_name", "Full name", 1),
        (1, "notes", "Notes", 1),
        (2, "pin", "PIN", 1),
        (3, "agree", "I agree", 1),
        (4, "color", "Colour", 1),
        (5, "country", "Country", 1),
        (6, "fruits", "Fruits", 1),
        (7, "ref_code", "Reference", 1),
        (8, "vertical", "Vertical", 1),
        (9, "comments", "Comments", 2),
        (10, "secret", "Password", 2),
    ]);
    let kinds: Vec<&FieldKind> = info.fields.iter().map(|f| &f.kind).collect();
    assert_eq!(kinds, vec![
        &FieldKind::Text { multiline: false, comb: false, max_len: None, password: false },
        &FieldKind::Text { multiline: true, comb: false, max_len: None, password: false },
        &FieldKind::Text { multiline: false, comb: true, max_len: Some(6), password: false },
        &FieldKind::Checkbox,
        &FieldKind::Radio,
        &FieldKind::Combo { editable: false },
        &FieldKind::List { multi: true },
        &FieldKind::Text { multiline: false, comb: false, max_len: None, password: false },
        &FieldKind::Text { multiline: false, comb: false, max_len: None, password: false },
        &FieldKind::Text { multiline: false, comb: false, max_len: None, password: false },
        &FieldKind::Text { multiline: false, comb: false, max_len: None, password: true },
    ]);
    let f = &info.fields;
    assert_eq!(f[3].on_states, vec!["Yes"]);
    assert_eq!(f[3].value, Value::None);
    assert_eq!(f[4].on_states, vec!["red", "green", "blue"]);
    assert_eq!(f[4].widgets.len(), 3);
    assert_eq!(f[4].value, Value::None);
    assert_eq!(f[5].value, Value::Text("France".into()));
    assert_eq!(f[5].options.iter().map(|(e, _)| e.as_str()).collect::<Vec<_>>(), vec!["France", "Germany", "Spain"]);
    assert_eq!(f[6].value, Value::Names(vec!["Banana".into()]));
    assert_eq!(f[6].options.len(), 4);
    assert!(f[7].read_only);
    assert_eq!(f[7].value, Value::Text("MP-2026".into()));
    assert!(info.fields.iter().filter(|x| x.id != 7).all(|x| !x.read_only));
    assert_eq!(f[8].widgets[0].rotation, 90);
    assert!(info.fields.iter().filter(|x| x.id != 8).all(|x| x.widgets.iter().all(|w| w.rotation == 0)));
    assert!(info.fields.iter().all(|x| x.widgets.iter().all(|w| !w.hidden)));
}

#[test]
fn form_fixture_fills_and_flattens() {
    let pdf = fixture("form.pdf");
    let values = vec![
        (0, Value::Text("Ada Lovelace".into())),
        (1, Value::Text("Line one\nLine two".into())),
        (2, Value::Text("123456".into())),
        (3, Value::Names(vec!["Yes".into()])),
        (4, Value::Names(vec!["green".into()])),
        (5, Value::Text("Spain".into())),
        (6, Value::Names(vec!["Apple".into(), "Cherry".into()])),
        (8, Value::Text("Up".into())),
        (9, Value::Text("Page two".into())),
        (10, Value::Text("hunter2-secret".into())),
    ];
    let out = fill_form(&pdf, &values, false).unwrap();
    let filled = list_form(&out).unwrap();
    for (id, value) in &values[..values.len() - 1] {
        assert_eq!(&filled.fields[*id as usize].value, value, "field {id}");
    }
    // The password is not stored.
    assert_eq!(filled.fields[10].value, Value::None);
    assert!(!out.windows(6).any(|w| w == b"hunter"));
    assert!(list_form(&fill_form(&pdf, &values, true).unwrap()).unwrap().fields.is_empty());
}

#[test]
fn xfa_fixtures() {
    let pure = list_form(&fixture("xfa-pure.pdf")).unwrap();
    assert_eq!((pure.xfa, pure.fields.len()), (Xfa::Pure, 0));
    let hybrid = list_form(&fixture("xfa-hybrid.pdf")).unwrap();
    assert_eq!(hybrid.xfa, Xfa::Hybrid);
    assert_eq!(hybrid.fields.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["name"]);
    let out = fill_form(&fixture("xfa-hybrid.pdf"), &[(0, Value::Text("x".into()))], false).unwrap();
    assert_eq!(list_form(&out).unwrap().xfa, Xfa::None);
}
