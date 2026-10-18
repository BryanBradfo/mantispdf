import type { ReactNode } from "react";
import { PageSEO } from "../components/seo/PageSEO";

interface Props {
  title: string;
  description: string;
  path: string;
  heading: string;
  intro: string;
  children: ReactNode;
  /** Wider column for tools with a large workspace (the Edit PDF editor). */
  wide?: boolean;
}

export default function ToolShell({ title, description, path, heading, intro, children, wide = false }: Props) {
  return (
    <div className={`mx-auto px-4 py-8 ${wide ? "max-w-6xl" : "max-w-2xl"}`}>
      <PageSEO title={title} description={description} path={path} />
      <h1 className="text-3xl font-bold text-gray-900 dark:text-[#e5e5e5]">{heading}</h1>
      <p className="mt-2 text-gray-600 dark:text-[#555]">{intro}</p>
      {children}
    </div>
  );
}

export const primaryButton =
  "rounded-lg bg-mantis-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-mantis-700 focus:outline-none focus:ring-2 focus:ring-mantis-500 focus:ring-offset-2 disabled:opacity-50";
export const secondaryButton =
  "rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-[#333] dark:text-[#aaa] dark:hover:bg-[#1a1a1a]";
export const inputClass =
  "mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-mantis-500 focus:outline-none focus:ring-1 focus:ring-mantis-500 dark:border-[#333] dark:bg-[#111] dark:text-[#ddd]";
export const panelClass =
  "mt-8 rounded-xl border border-mantis-200 bg-mantis-50/50 p-6 dark:border-mantis-900 dark:bg-[#0f1a0f]";
