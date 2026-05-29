#![no_std]

mod storage;
mod test;

use soroban_sdk::{contract, contractimpl, Address, Env, Symbol, Vec};
use storage::{DataKey, MemberAddedEvent, MemberRemovedEvent};

#[contract]
pub struct GroupTreasuryContract;

#[contractimpl]
impl GroupTreasuryContract {
    pub fn initialize(env: Env, admin: Address, members: Vec<Address>) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Members, &members);
    }

    pub fn add_member(env: Env, member: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        let mut members: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Members)
            .expect("not initialized");

        for m in members.iter() {
            if m == member {
                panic!("already a member");
            }
        }

        members.push_back(member.clone());
        env.storage().instance().set(&DataKey::Members, &members);

        env.events().publish(
            (Symbol::new(&env, "member_added"),),
            MemberAddedEvent { member },
        );
    }

    pub fn remove_member(env: Env, member: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        if member == admin {
            panic!("cannot remove admin");
        }

        let members: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Members)
            .expect("not initialized");

        let mut remaining: Vec<Address> = Vec::new(&env);
        for m in members.iter() {
            if m != member {
                remaining.push_back(m);
            }
        }

        env.storage().instance().set(&DataKey::Members, &remaining);

        env.events().publish(
            (Symbol::new(&env, "member_removed"),),
            MemberRemovedEvent { member },
        );
    }

    pub fn deposit(env: Env, from: Address, amount: i128) {
        from.require_auth();

        if amount <= 0 {
            panic!("amount must be positive");
        }

        let members: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Members)
            .expect("not initialized");

        let mut is_member = false;
        for m in members.iter() {
            if m == from {
                is_member = true;
                break;
            }
        }
        if !is_member {
            panic!("unauthorized: not a member");
        }

        let key = DataKey::Balance(from.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(current + amount));
    }

    pub fn balance(env: Env, address: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(address))
            .unwrap_or(0)
    }

    pub fn members(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Members)
            .expect("not initialized")
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }
}
