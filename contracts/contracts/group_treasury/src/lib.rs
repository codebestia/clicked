#![no_std]

mod storage;
mod test;
mod token_interface;

use soroban_sdk::{contract, contractimpl, Address, Env, Map, Symbol, Vec};
use storage::{
    DataKey, DepositEvent, MemberAddedEvent, MemberRemovedEvent, ProposalApprovedEvent,
    ProposalRejectedEvent, ProposalStatus, WithdrawEvent, WithdrawProposal, WithdrawVoteCastEvent,
};
use token_interface::TokenClient;

fn require_admin(env: &Env) -> Address {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("not initialized");
    admin.require_auth();
    admin
}

#[contract]
pub struct GroupTreasuryContract;

#[contractimpl]
impl GroupTreasuryContract {
    /// One-time initialisation. Sets the admin, the approval `threshold`, and sets up the
    /// balances map and members set. `threshold` is the number of approvals required to
    /// execute a withdraw proposal and must be at least 1.
    pub fn initialize(env: Env, admin: Address, _token: Address, threshold: u32) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        if threshold == 0 {
            panic!("threshold must be at least 1");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &threshold);
        env.storage().instance().set(&DataKey::ProposalCount, &0u32);
        let balances: Map<Address, i128> = Map::new(&env);
        env.storage().instance().set(&DataKey::Balances, &balances);
        let members: Vec<Address> = Vec::new(&env);
        env.storage().instance().set(&DataKey::Members, &members);
    }

    /// Returns the configured approval threshold.
    pub fn get_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .expect("not initialized")
    }

    /// Admin-only: Add a new member to the treasury.
    pub fn add_member(env: Env, member: Address) {
        let admin = require_admin(&env);

        let mut members: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Members)
            .unwrap_or_else(|| Vec::new(&env));

        // Check if member already exists
        for existing_member in members.iter() {
            if existing_member == member {
                panic!("member already exists");
            }
        }

        members.push_back(member.clone());
        env.storage().instance().set(&DataKey::Members, &members);

        env.events().publish(
            (Symbol::new(&env, "member_added"),),
            MemberAddedEvent {
                member: member.clone(),
                added_by: admin,
            },
        );
    }

    /// Admin-only: Remove a member from the treasury.
    pub fn remove_member(env: Env, member: Address) {
        let admin = require_admin(&env);

        let mut members: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Members)
            .unwrap_or_else(|| Vec::new(&env));

        let mut found = false;
        let mut new_members: Vec<Address> = Vec::new(&env);
        for existing_member in members.iter() {
            if existing_member == member {
                found = true;
            } else {
                new_members.push_back(existing_member);
            }
        }

        if !found {
            panic!("member not found");
        }

        env.storage()
            .instance()
            .set(&DataKey::Members, &new_members);

        env.events().publish(
            (Symbol::new(&env, "member_removed"),),
            MemberRemovedEvent {
                member: member.clone(),
                removed_by: admin,
            },
        );
    }

    /// Check if an address is a member of the treasury.
    pub fn is_member(env: Env, member: Address) -> bool {
        let members: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Members)
            .unwrap_or_else(|| Vec::new(&env));

        for existing_member in members.iter() {
            if existing_member == member {
                return true;
            }
        }
        false
    }

    /// Get all members of the treasury.
    pub fn get_members(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Members)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Transfer `amount` tokens from `from` into the treasury.
    pub fn deposit(env: Env, from: Address, token: Address, amount: i128) {
        if amount <= 0 {
            panic!("amount must be positive");
        }
        from.require_auth();

        TokenClient::new(&env, &token).transfer(&from, &env.current_contract_address(), &amount);

        let mut balances: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Balances)
            .unwrap_or_else(|| Map::new(&env));

        let current = balances.get(token.clone()).unwrap_or(0);
        balances.set(token.clone(), current + amount);
        env.storage().instance().set(&DataKey::Balances, &balances);

        env.events().publish(
            (Symbol::new(&env, "deposit"),),
            DepositEvent { from, amount },
        );
    }

    /// Admin-only: transfer `amount` tokens from the treasury to `to`.
    pub fn withdraw(env: Env, to: Address, token: Address, amount: i128) {
        if amount <= 0 {
            panic!("amount must be positive");
        }

        let admin = require_admin(&env);

        let mut balances: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Balances)
            .unwrap_or_else(|| Map::new(&env));

        let current = balances.get(token.clone()).unwrap_or(0);
        if current < amount {
            panic!("insufficient funds");
        }

        TokenClient::new(&env, &token).transfer(&env.current_contract_address(), &to, &amount);

        balances.set(token.clone(), current - amount);
        env.storage().instance().set(&DataKey::Balances, &balances);

        env.events().publish(
            (Symbol::new(&env, "withdraw"),),
            WithdrawEvent { to, amount },
        );
    }

    /// Returns the token balance currently held by this treasury.
    pub fn balance(env: Env, token: Address) -> i128 {
        let balances: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Balances)
            .unwrap_or_else(|| Map::new(&env));

        balances.get(token).unwrap_or(0)
    }

    /// Member-only: approve a pending withdraw proposal. Each member may vote at
    /// most once per proposal. When the running approval count reaches the
    /// configured `threshold` the proposal transitions to `Passed` (approved)
    /// and a `ProposalApprovedEvent` is emitted.
    pub fn approve_withdraw(env: Env, approver: Address, proposal_id: u32) {
        let mut proposal = Self::require_votable(&env, &approver, proposal_id);

        env.storage()
            .instance()
            .set(&DataKey::Vote(proposal_id, approver.clone()), &true);

        proposal.approvals += 1;

        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .expect("not initialized");

        if proposal.approvals >= threshold {
            proposal.status = ProposalStatus::Passed;
            env.events().publish(
                (Symbol::new(&env, "proposal_approved"),),
                ProposalApprovedEvent {
                    id: proposal_id,
                    approvals: proposal.approvals,
                    threshold,
                },
            );
        }

        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "withdraw_vote"),),
            WithdrawVoteCastEvent {
                id: proposal_id,
                voter: approver,
                approve: true,
            },
        );
    }

    /// Member-only: reject a pending withdraw proposal. Each member may vote at
    /// most once per proposal. When the rejection count reaches the blocking
    /// minority — the point at which the remaining members can no longer reach
    /// `threshold` approvals — the proposal transitions to `Rejected` and a
    /// `ProposalRejectedEvent` is emitted.
    pub fn reject_withdraw(env: Env, rejecter: Address, proposal_id: u32) {
        let mut proposal = Self::require_votable(&env, &rejecter, proposal_id);

        env.storage()
            .instance()
            .set(&DataKey::Vote(proposal_id, rejecter.clone()), &false);

        proposal.rejections += 1;

        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .expect("not initialized");
        let member_count = Self::get_members(env.clone()).len();
        // Approval becomes impossible once fewer than `threshold` members remain
        // un-rejected, i.e. once rejections > member_count - threshold.
        let blocking_minority = member_count.saturating_sub(threshold) + 1;

        if proposal.rejections >= blocking_minority {
            proposal.status = ProposalStatus::Rejected;
            env.events().publish(
                (Symbol::new(&env, "proposal_rejected"),),
                ProposalRejectedEvent {
                    id: proposal_id,
                    rejections: proposal.rejections,
                },
            );
        }

        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "withdraw_vote"),),
            WithdrawVoteCastEvent {
                id: proposal_id,
                voter: rejecter,
                approve: false,
            },
        );
    }

    /// Returns the withdraw proposal with the given id. Panics if it does not exist.
    pub fn get_proposal(env: Env, proposal_id: u32) -> WithdrawProposal {
        env.storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found")
    }

    /// Shared validation for voting: authenticates the voter, confirms
    /// membership, loads the proposal, and ensures it is pending, not expired,
    /// and not already voted on by this address. Returns the loaded proposal.
    fn require_votable(env: &Env, voter: &Address, proposal_id: u32) -> WithdrawProposal {
        voter.require_auth();

        if !Self::is_member(env.clone(), voter.clone()) {
            panic!("not a member");
        }

        let proposal: WithdrawProposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        if proposal.status != ProposalStatus::Active {
            panic!("proposal is not pending");
        }
        if env.ledger().timestamp() >= proposal.expires_at {
            panic!("proposal expired");
        }
        if env
            .storage()
            .instance()
            .has(&DataKey::Vote(proposal_id, voter.clone()))
        {
            panic!("already voted");
        }

        proposal
    }
}
