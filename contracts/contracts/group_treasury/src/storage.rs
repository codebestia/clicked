use soroban_sdk::{contracttype, Address};

#[contracttype]
pub enum DataKey {
    Admin,
    Balances,
    Members,
    ProposalCount,
    WithdrawProposal(u32),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Pending,
    Approved,
    Rejected,
    Executed,
}

#[contracttype]
#[derive(Clone)]
pub struct WithdrawProposal {
    pub id: u32,
    pub proposer: Address,
    pub to: Address,
    pub token: Address,
    pub amount: i128,
    pub approvals: u32,
    pub status: ProposalStatus,
    pub expires_at: u32,
}

#[contracttype]
pub struct DepositEvent {
    pub from: Address,
    pub amount: i128,
}

#[contracttype]
pub struct WithdrawEvent {
    pub to: Address,
    pub amount: i128,
}

#[contracttype]
pub struct MemberAddedEvent {
    pub member: Address,
    pub added_by: Address,
}

#[contracttype]
pub struct MemberRemovedEvent {
    pub member: Address,
    pub removed_by: Address,
}

#[contracttype]
pub struct ProposalCreatedEvent {
    pub id: u32,
    pub proposer: Address,
    pub to: Address,
    pub token: Address,
    pub amount: i128,
    pub expires_at: u32,
}
