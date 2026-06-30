package com.example.service;

import com.example.model.Account;

public class AccountService {
    public String describe(Account account) {
        return "owner=" + account.getOwner();
    }
}
