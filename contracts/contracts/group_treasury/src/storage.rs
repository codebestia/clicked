use soroban_sdk::{contracttype, Address};

#[contracttype]
pub enum DataKey {
    Admin,
    Members,
    Balance(Address),
}

#[contracttype]
pub struct MemberAddedEvent {
    pub member: Address,
}

#[contracttype]
pub struct MemberRemovedEvent {
    pub member: Address,
}
