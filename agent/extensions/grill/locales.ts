export type Language = "en" | "id";

type LocaleKey =
	| "navigate"
	| "select"
	| "typeSomething"
	| "note"
	| "cancel"
	| "preview"
	| "noPreview"
	| "noteHeader"
	| "customEditorTitle"
	| "noteEditorTitle";

export const STRINGS: Record<Language, Record<LocaleKey, string>> = {
	en: {
		navigate: "↑/↓ to navigate",
		select: "Enter to select",
		typeSomething: "Type something.",
		note: "n to add note",
		cancel: "Esc to cancel",
		preview: "Preview",
		noPreview: "No preview available",
		noteHeader: "Note",
		customEditorTitle: "Type your answer",
		noteEditorTitle: "Add a note",
	},
	id: {
		navigate: "↑/↓ untuk navigasi",
		select: "Enter untuk pilih",
		typeSomething: "Ketik jawaban.",
		note: "n untuk catatan",
		cancel: "Esc untuk batal",
		preview: "Pratinjau",
		noPreview: "Tidak ada pratinjau",
		noteHeader: "Catatan",
		customEditorTitle: "Ketik jawaban Anda",
		noteEditorTitle: "Tambahkan catatan",
	},
};

export function strings(lang: Language): Record<LocaleKey, string> {
	return STRINGS[lang] ?? STRINGS.en;
}
