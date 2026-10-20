import { Check, ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export interface SelectOption {
	value: string;
	label: string;
}

export interface SelectGroup {
	label: string;
	options: SelectOption[];
}

export interface OptionSelectProps {
	/** The chosen value. */
	value: string;
	/** Options above the groups, such as "Original size". */
	options?: SelectOption[];
	/** Grouped options, each with a heading in the list. */
	groups?: SelectGroup[];
	onChange: (value: string) => void;
	/** Read by a screen reader where no visible label exists. */
	label: string;
}

/**
 * A list of options that the app can draw itself.
 *
 * A native `select` cannot be styled beyond its closed field: the popup belongs
 * to the operating system, so on a phone it arrives as a full-screen wheel.
 * This keeps the closed field and the open list inside the design, and gives
 * grouped options a real heading instead of a disabled row.
 */
export function OptionSelect({
	value,
	options = [],
	groups = [],
	onChange,
	label,
}: OptionSelectProps) {
	const [open, setOpen] = useState(false);
	/** Opened upward when there is no room below the field. */
	const [opensUp, setOpensUp] = useState(false);
	/** Row highlighted by the keyboard, as an index into the flat list. */
	const [active, setActive] = useState(-1);
	const rootRef = useRef<HTMLDivElement>(null);

	const flat = useMemo(
		() => [...options, ...groups.flatMap((group) => group.options)],
		[options, groups],
	);
	const current = flat.find((option) => option.value === value)?.label ?? "";

	useEffect(() => {
		if (!open) return;

		const onPointerDown = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};

		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const openList = () => {
		const rect = rootRef.current?.getBoundingClientRect();
		setOpensUp(rect ? window.innerHeight - rect.bottom < 300 : false);
		setActive(flat.findIndex((option) => option.value === value));
		setOpen(true);
	};

	const choose = (next: string) => {
		onChange(next);
		setOpen(false);
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
		if (!open) {
			if (
				event.key === "ArrowDown" ||
				event.key === "Enter" ||
				event.key === " "
			) {
				event.preventDefault();
				openList();
			}
			return;
		}

		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActive((current) => {
				const next = current + step;
				if (next < 0) return flat.length - 1;
				if (next >= flat.length) return 0;
				return next;
			});
			return;
		}

		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			const option = flat[active];
			if (option) choose(option.value);
			return;
		}

		if (event.key === "Tab") setOpen(false);
	};

	const row = (option: SelectOption) => {
		const selected = option.value === value;
		const highlighted = flat[active]?.value === option.value;

		return (
			<button
				key={option.value}
				type="button"
				role="option"
				aria-selected={selected}
				onClick={() => choose(option.value)}
				onPointerEnter={() =>
					setActive(flat.findIndex((entry) => entry.value === option.value))
				}
				className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] ${
					highlighted ? "bg-[#f3f3f1]" : ""
				} ${selected ? "font-semibold text-[#1c1c1e]" : "text-[#3a3a3c]"}`}
			>
				{option.label}
				{selected && (
					<Check className="h-3.5 w-3.5 text-[#1c1c1e]" aria-hidden="true" />
				)}
			</button>
		);
	};

	return (
		<div ref={rootRef} className="relative">
			<button
				type="button"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={label}
				onClick={() => (open ? setOpen(false) : openList())}
				onKeyDown={onKeyDown}
				className="flex w-full items-center justify-between gap-2 rounded-[10px] border border-[#e6e6e4] bg-white px-2.5 py-2 text-left text-[11.5px] text-[#1c1c1e] shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
			>
				<span className="truncate">{current}</span>
				<ChevronDown
					aria-hidden="true"
					className={`h-3.5 w-3.5 shrink-0 text-[#8e8e93] transition-transform ${
						open ? "rotate-180" : ""
					}`}
				/>
			</button>

			{open && (
				<div
					role="listbox"
					aria-label={label}
					className={`absolute left-0 right-0 z-30 max-h-64 overflow-y-auto rounded-xl border border-[#e6e6e4] bg-white p-1 shadow-[0_12px_32px_rgba(0,0,0,0.16)] ${
						opensUp ? "bottom-full mb-1" : "top-full mt-1"
					}`}
				>
					{options.map(row)}
					{groups.map((group) => (
						<div key={group.label}>
							<p className="px-2.5 pt-2 pb-1 text-[9.5px] font-semibold tracking-[0.12em] text-[#b0b0ac] uppercase">
								{group.label}
							</p>
							{group.options.map(row)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
