//! Pure conversion of the raw fill values read by `binding` (strings and
//! f64s, as JS hands them over) into `(field id, Value)` pairs. Field ids,
//! kinds and value limits are checked against the form by `fill_form`.

use super::{MAX_FIELDS, Value, invalid};

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum RawValue {
    Text(String),
    Names(Vec<String>),
    None,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawEntry {
    pub id: f64,
    pub value: RawValue,
}

/// A whole number in `0..=u32::MAX`.
fn field_id(v: f64, i: usize) -> Result<u32, String> {
    if v.is_finite() && v.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&v) {
        Ok(v as u32)
    } else {
        Err(invalid(&format!("values[{i}].id")))
    }
}

pub(crate) fn validate_values(raw: Vec<RawEntry>) -> Result<Vec<(u32, Value)>, String> {
    if raw.len() > MAX_FIELDS {
        return Err(invalid("values"));
    }
    raw.into_iter()
        .enumerate()
        .map(|(i, entry)| {
            let value = match entry.value {
                RawValue::Text(t) => Value::Text(t),
                RawValue::Names(n) => Value::Names(n),
                RawValue::None => Value::None,
            };
            Ok((field_id(entry.id, i)?, value))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: f64, value: RawValue) -> RawEntry {
        RawEntry { id, value }
    }

    #[test]
    fn converts_each_value_kind() {
        let got = validate_values(vec![
            entry(0.0, RawValue::Text("a".into())),
            entry(3.0, RawValue::Names(vec!["On".into()])),
            entry(4.0, RawValue::None),
        ])
        .unwrap();
        assert_eq!(got, vec![
            (0, Value::Text("a".into())),
            (3, Value::Names(vec!["On".into()])),
            (4, Value::None),
        ]);
    }

    #[test]
    fn refuses_bad_ids_and_too_many_values() {
        for bad in [-1.0, 0.5, f64::NAN, f64::INFINITY, 5e9] {
            let err = validate_values(vec![entry(0.0, RawValue::None), entry(bad, RawValue::None)]).unwrap_err();
            assert_eq!(err, "Invalid form settings: values[1].id", "{bad}");
        }
        let many = vec![entry(0.0, RawValue::None); MAX_FIELDS + 1];
        assert_eq!(validate_values(many).unwrap_err(), "Invalid form settings: values");
    }
}
