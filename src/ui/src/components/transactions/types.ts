import type { TxType } from '../../lib/transaction-filters';

export type { TxType } from '../../lib/transaction-filters';

export interface Transaction {
  id: string; date: string; merchant: string;
  sourceCategory: string; sourceSubCategory?: string; sourceType: TxType;
  sourceClassificationTrusted: boolean;
  category: string;
  subCategory?: string; account: string; accountId?: string; amount: number; type: TxType; notes?: string;
  splits?: TransactionSplit[];
}

export interface TransactionSplit {
  id: string;
  amount: number;
  category: string;
  subCategory: string;
  type: TxType;
}

export type EditableTransaction = Omit<
  Transaction,
  'id' | 'splits' | 'sourceCategory' | 'sourceSubCategory' | 'sourceType' | 'sourceClassificationTrusted'
>;

export interface PageResponse { rows: Transaction[]; total: number; }
export interface MainCategory { id: string; name: string; type: TxType; subCategories: { id: string; name: string }[]; }
export interface Account { id: string; name: string; alias?: string; type?: string; }

export type RecurringPick = 'none' | 'weekly' | 'monthly' | 'yearly';
