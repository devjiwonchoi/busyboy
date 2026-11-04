//! Element refs (`e<N>`) and their staleness rules.
//!
//! Numbers are monotonic per app. An element seen in the previous snapshot keeps its
//! number, so refs stay stable while the UI does. Refs from the latest two snapshots
//! resolve; older ones are stale.

use std::collections::HashMap;

use crate::platform::ProcessRef;

#[derive(Debug, Clone)]
pub struct RefEntry<E> {
    pub number: u32,
    pub handle: E,
    pub process: ProcessRef,
    pub window_id: String,
    pub role: String,
    pub generation: u64,
}

pub enum Lookup<'a, E> {
    Found(&'a RefEntry<E>),
    /// Issued before, but not in the latest two snapshots.
    Stale,
    /// Never issued for this app.
    NotFound,
}

/// One element offered to [`RefTable::commit`].
pub struct NewRef<E> {
    pub handle: E,
    pub key: u64,
    pub role: String,
}

pub struct RefTable<E> {
    generation: u64,
    next_number: u32,
    current: HashMap<u32, RefEntry<E>>,
    previous: HashMap<u32, RefEntry<E>>,
    keys: HashMap<u64, Vec<u32>>,
}

impl<E: Clone> Default for RefTable<E> {
    fn default() -> Self {
        RefTable { generation: 0, next_number: 1, current: HashMap::new(), previous: HashMap::new(), keys: HashMap::new() }
    }
}

/// Parses `e12` into 12.
pub fn parse_ref(text: &str) -> Option<u32> {
    let number = text.trim().strip_prefix('e')?.parse::<u32>().ok()?;
    (number > 0).then_some(number)
}

pub fn format_ref(number: u32) -> String {
    format!("e{number}")
}

impl<E: Clone> RefTable<E> {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Records a new snapshot and returns the ref number for each element, in order.
    /// `same` compares two handles for identity.
    pub fn commit(
        &mut self,
        process: ProcessRef,
        window_id: &str,
        elements: Vec<NewRef<E>>,
        same: impl Fn(&E, &E) -> bool,
    ) -> Vec<u32> {
        self.generation += 1;
        let generation = self.generation;
        let mut next: HashMap<u32, RefEntry<E>> = HashMap::with_capacity(elements.len());
        let mut next_keys: HashMap<u64, Vec<u32>> = HashMap::with_capacity(elements.len());
        let mut numbers = Vec::with_capacity(elements.len());

        for element in elements {
            // Reuse the number of the same element from the latest snapshot of this process.
            let reused = self.keys.get(&element.key).and_then(|candidates| {
                candidates.iter().copied().find(|number| {
                    !next.contains_key(number)
                        && self.current.get(number).is_some_and(|entry| {
                            entry.process == process && entry.role == element.role && same(&entry.handle, &element.handle)
                        })
                })
            });
            let number = reused.unwrap_or_else(|| {
                let number = self.next_number;
                self.next_number += 1;
                number
            });

            next_keys.entry(element.key).or_default().push(number);
            next.insert(
                number,
                RefEntry {
                    number,
                    handle: element.handle,
                    process,
                    window_id: window_id.to_owned(),
                    role: element.role,
                    generation,
                },
            );
            numbers.push(number);
        }

        self.previous = std::mem::replace(&mut self.current, next);
        self.keys = next_keys;
        numbers
    }

    pub fn lookup(&self, text: &str) -> Lookup<'_, E> {
        let Some(number) = parse_ref(text) else {
            return Lookup::NotFound;
        };
        if let Some(entry) = self.current.get(&number).or_else(|| self.previous.get(&number)) {
            return Lookup::Found(entry);
        }
        if number < self.next_number {
            return Lookup::Stale;
        }
        Lookup::NotFound
    }

    /// Drops every retained handle, e.g. when the app quits. Numbers keep growing so
    /// old refs report stale.
    pub fn clear(&mut self) {
        self.current.clear();
        self.previous.clear();
        self.keys.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROCESS: ProcessRef = ProcessRef { pid: 10, start_time: 1 };

    fn refs(items: &[(u64, &str)]) -> Vec<NewRef<u64>> {
        items.iter().map(|(key, role)| NewRef { handle: *key, key: *key, role: (*role).to_owned() }).collect()
    }

    fn found<E: Clone>(table: &RefTable<E>, text: &str) -> bool {
        matches!(table.lookup(text), Lookup::Found(_))
    }

    #[test]
    fn keeps_numbers_for_the_same_element_across_snapshots() {
        let mut table = RefTable::default();
        let first = table.commit(PROCESS, "w1", refs(&[(100, "button"), (200, "text area")]), |a, b| a == b);
        assert_eq!(first, vec![1, 2]);

        let second = table.commit(PROCESS, "w1", refs(&[(200, "text area"), (300, "button")]), |a, b| a == b);
        assert_eq!(second, vec![2, 3]);

        let changed_role = table.commit(PROCESS, "w1", refs(&[(200, "group")]), |a, b| a == b);
        assert_eq!(changed_role, vec![4]);
    }

    #[test]
    fn resolves_only_the_latest_two_snapshots() {
        let mut table = RefTable::default();
        table.commit(PROCESS, "w1", refs(&[(1, "button")]), |a, b| a == b);
        table.commit(PROCESS, "w1", refs(&[(2, "button")]), |a, b| a == b);
        assert!(found(&table, "e1"), "previous snapshot still resolves");
        assert!(found(&table, "e2"));

        table.commit(PROCESS, "w1", refs(&[(3, "button")]), |a, b| a == b);
        assert!(matches!(table.lookup("e1"), Lookup::Stale));
        assert!(found(&table, "e2"));
        assert!(matches!(table.lookup("e99"), Lookup::NotFound));
        assert!(matches!(table.lookup("x1"), Lookup::NotFound));
    }

    #[test]
    fn restarted_processes_get_new_numbers() {
        let mut table = RefTable::default();
        table.commit(PROCESS, "w1", refs(&[(1, "button")]), |a, b| a == b);
        let restarted = ProcessRef { pid: 10, start_time: 2 };
        let numbers = table.commit(restarted, "w1", refs(&[(1, "button")]), |a, b| a == b);
        assert_eq!(numbers, vec![2]);

        table.clear();
        assert!(matches!(table.lookup("e2"), Lookup::Stale));
    }
}
