import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

type TuiPanelProps = {
  title: string
  children: ReactNode
  className?: string
  bodyClassName?: string
  right?: ReactNode
}

// btop-style bordered panel: the title breaks the top border line  ┤ TITLE ├
export function TuiPanel({
  title,
  children,
  className,
  bodyClassName,
  right,
}: TuiPanelProps) {
  return (
    <section
      className={cn(
        "relative flex min-h-0 flex-col border border-neutral-800 bg-black",
        className,
      )}
    >
      <div className="pointer-events-none absolute -top-[9px] left-3 flex items-center gap-1 bg-black px-1 text-[11px] leading-none tracking-widest text-neutral-500">
        <span className="text-neutral-700">┤</span>
        <span className="font-bold text-neutral-300">{title}</span>
        <span className="text-neutral-700">├</span>
      </div>
      {right ? (
        <div className="pointer-events-none absolute -top-[9px] right-3 flex items-center gap-1 bg-black px-1 text-[11px] leading-none text-neutral-500">
          {right}
        </div>
      ) : null}
      <div className={cn("min-h-0 flex-1", bodyClassName)}>{children}</div>
    </section>
  )
}
