import { createContext, useContext } from "react";
import type { Account, Category } from "../shared/models";
import type { Profile } from "../shared/profile";
import type { TransactionAppearance } from "../shared/transaction-appearance";
import type { AppearanceSaveState } from "./appearance-autosave";
export type Workspace = {
  accounts: Account[];
  categories: Category[];
  refresh: () => void;
  version: number;
  navigate: (path: string) => void;
  notify: (message: string) => void;
  demo: boolean;
  sourceUrl: string;
  username: string;
  displayName: string;
  updateProfile: (profile: Profile) => void;
  transactionAppearance: TransactionAppearance;
  updateTransactionAppearance: (appearance: TransactionAppearance) => void;
  appearanceSaveState: AppearanceSaveState;
  retryTransactionAppearance: () => void;
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
};
export const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("Workspace missing");
  return ctx;
}
