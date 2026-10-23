// ---- Shared types ---------------------------------------------------------
export type AccountType = 'checking' | 'savings' | 'credit' | 'investment' | 'loan' | 'uncategorized';
export type AccountSource = 'manual' | 'simplefin';
// `transfer` covers credit card payments, account-to-account moves, and
// any other transaction where money moves between two of the user's own
// accounts. Transfers are excluded from income/expense totals because
// they don't change net worth — they just reallocate it.
export type TransactionType = 'income' | 'expense' | 'transfer';

export interface Account {
  id: string;
  source: AccountSource;
  name: string;
  type: AccountType;
  balance: number;
  institution?: string;
  // Pay-down fields — only meaningful for credit/loan accounts but live
  // on every account for simplicity.
  interestRate: number;
  minPayment: number;
  plannedPayment: number;
  includeInPaydown: boolean;
  // `hidden` removes the account from financial read views and pauses
  // SimpleFIN sync for that account. It survives sync because the sync
  // helper checks the existing row before writing.
  hidden: boolean;
  // User-set display alias. NULL means "use the canonical name". Never
  // touched by SimpleFIN sync, so the user's chosen name persists
  // across every re-sync. Resolved at read time in the Transactions
  // page so renaming flows through to historical transactions.
  alias?: string | null;
}
export interface SubCategory {
  id: string;
  name: string;
  planned: number;
  icon?: string;
}
export interface MainCategory {
  id: string;
  name: string;
  type: TransactionType;
  icon?: string;
  sortOrder: number;
  subCategories: SubCategory[];
}
export interface Transaction {
  id: string;
  date: string;
  merchant: string;
  sourceCategory: string;
  sourceSubCategory?: string;
  sourceType: TransactionType;
  sourceClassificationTrusted: boolean;
  category: string;
  subCategory?: string;
  categoryId?: string;
  subCategoryId?: string;
  account: string;
  accountId?: string;
  amount: number;
  type: TransactionType;
  notes?: string;
  splits: TransactionSplit[];
}
export interface TransactionSplit {
  id: string;
  amount: number;
  amountCents: number;
  category: string;
  subCategory: string;
  categoryId?: string;
  subCategoryId?: string;
  type: TransactionType;
  sortOrder: number;
}

export interface DashboardActivity {
  income: number;
  expense: number;
  transferCount: number;
  recent: Array<Pick<Transaction, 'id' | 'date' | 'merchant' | 'category' | 'subCategory' | 'account' | 'amount' | 'type'>>;
}

export interface BudgetActivityRow {
  category: string;
  subCategory: string;
  type: 'income' | 'expense';
  actual: number;
  transactions: Array<{
    id: string;
    date: string;
    merchant: string;
    account: string;
    amount: number;
    hasSplits: boolean;
    parentAmount: number;
  }>;
}
