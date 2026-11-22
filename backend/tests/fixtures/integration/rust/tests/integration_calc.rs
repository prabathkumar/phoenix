use demo::add;
#[test]
fn add_integration() { assert_eq!(add(add(1, 2), add(3, 4)), 10); }
