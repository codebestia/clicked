#![no_std]

mod storage;
mod test;
mod token_interface;

use soroban_sdk::{contract, contractimpl, Address, Env, Map, Symbol, Vec};
use storage::{
    DataKey, DepositEvent, MemberAddedEvent, MemberRemovedEvent, ProposalCreatedEvent,
    ProposalStatus, WithdrawEvent, WithdrawProposal,
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
    /// One-time initialisation. Sets the admin and sets up the balances map and members set.
    pub fn initialize(env: Env, admin: Address, _token: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        let balances: Map<Address, i128> = Map::new(&env);
        env.storage().instance().set(&DataKey::Balances, &balances);
        let members: Vec<Address> = Vec::new(&env);
        env.storage().instance().set(&DataKey::Members, &members);
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

    /// Member-only: Create a withdrawal proposal. Returns the new proposal ID.
    pub fn propose_withdraw(
        env: Env,
        proposer: Address,
        to: Address,
        token: Address,
        amount: i128,
        ttl_ledgers: u32,
    ) -> u32 {
        proposer.require_auth();

        // Verify proposer is a member
        let members: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Members)
            .unwrap_or_else(|| Vec::new(&env));
        let is_member = members.iter().any(|m| m == proposer);
        if !is_member {
            panic!("not a member");
        }

        // Verify amount > 0
        if amount <= 0 {
            panic!("amount must be positive");
        }

        // Verify sufficient treasury balance
        let balances: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&DataKey::Balances)
            .unwrap_or_else(|| Map::new(&env));
        let current = balances.get(token.clone()).unwrap_or(0);
        if current < amount {
            panic!("insufficient funds");
        }

        // Increment proposal count and get new ID
        let id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0_u32)
            + 1;
        env.storage().instance().set(&DataKey::ProposalCount, &id);

        let expires_at = env.ledger().sequence() + ttl_ledgers;

        // Auto-add proposer's approval
        let mut approvals: Vec<Address> = Vec::new(&env);
        approvals.push_back(proposer.clone());

        let proposal = WithdrawProposal {
            id,
            proposer: proposer.clone(),
            to: to.clone(),
            token: token.clone(),
            amount,
            approvals,
            status: ProposalStatus::Pending,
            expires_at,
        };
        env.storage()
            .instance()
            .set(&DataKey::Proposal(id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "proposal_created"),),
            ProposalCreatedEvent {
                id,
                proposer,
                to,
                token,
                amount,
                expires_at,
            },
        );

        id
    }
}
