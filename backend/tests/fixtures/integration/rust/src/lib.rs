pub fn add(a: i32, b: i32) -> i32 { a + b }
#[cfg(test)]
mod tests { use super::*; #[test] fn add_unit() { assert_eq!(add(1, 2), 3); } }
