import { createContext, useContext } from "react";
import type { Account, Category } from "../shared/models";
export type Workspace = {
  accounts: Account[];
  categories: Category[];
  refresh: () => void;
  version: number;
  navigate: (path: string) => void;
  notify: (message: string) => void;
  demo: boolean;
  sourceUrl: string;
};
export const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("Workspace missing");
  return ctx;
}
