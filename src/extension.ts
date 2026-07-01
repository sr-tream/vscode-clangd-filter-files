import * as vscode from 'vscode';

const CLANGD_EXTENSION_ID = 'llvm-vs-code-extensions.vscode-clangd';
const SENTINEL = '__clangdFilterFilesInstalled__';

const enum LCState { Stopped = 1, Running = 2, Starting = 3 }

interface StateChangeEvent { oldState: LCState; newState: LCState; }

interface MutableLanguageClient {
    clientOptions: { middleware?: any };
    diagnostics?: vscode.DiagnosticCollection;
    onDidChangeState(listener: (e: StateChangeEvent) => void): vscode.Disposable;
    sendNotification?(method: string, params?: any): Promise<void>;
    state: LCState;
}

interface ClangdApiV1 {
    languageClient: MutableLanguageClient | undefined;
}

interface ClangdExtension {
    getApi(version: 1): ClangdApiV1;
}

let logChannel: vscode.OutputChannel | undefined;

function log(message: string): void {
    if (!vscode.workspace.getConfiguration('clangd-filter-files').get<boolean>('log')) return;
    if (!logChannel) logChannel = vscode.window.createOutputChannel('clangd Filter Files');
    logChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function allowedSchemes(): Set<string> {
    const cfg = vscode.workspace.getConfiguration('clangd-filter-files').get<string[]>('allowedSchemes');
    return new Set(cfg ?? ['file']);
}

function isOutsideWorkspace(uri: vscode.Uri | undefined): boolean {
    if (!uri) return false;
    if (!allowedSchemes().has(uri.scheme)) return false;
    return vscode.workspace.getWorkspaceFolder(uri) === undefined;
}

const CLANGD_LANGS = new Set(['c', 'cpp', 'cuda-cpp', 'objective-c', 'objective-cpp']);
const DID_CLOSE_TEXT_DOCUMENT = 'textDocument/didClose';
const POST_CLOSE_DIAGNOSTIC_CLEAR_DELAYS_MS = [250, 1000, 2500];

function isClangdFiltered(doc: vscode.TextDocument): boolean {
    return CLANGD_LANGS.has(doc.languageId) && isOutsideWorkspace(doc.uri);
}

function documentOrUriUri(document: vscode.TextDocument | vscode.Uri): vscode.Uri {
    return document instanceof vscode.Uri ? document : document.uri;
}

function emptyDiagnosticReport(): any {
    return { kind: 'full', items: [] };
}

function filterWorkspaceDiagnosticReport(report: any): any {
    if (!report || !Array.isArray(report.items)) return report;

    const items = report.items.filter((item: any) => !isOutsideWorkspace(item?.uri));
    if (items.length === report.items.length) return report;
    return { ...report, items };
}

function clearClientDiagnostics(client: MutableLanguageClient, uri: vscode.Uri): void {
    const diagnostics = client.diagnostics;
    if (!diagnostics) {
        log(`cannot clear diagnostics ${uri.toString()}; language client has no diagnostics collection`);
        return;
    }
    diagnostics.set(uri, []);
    log(`cleared diagnostics ${uri.toString()}`);
}

function clearAlreadyOpenFilteredDiagnostics(client: MutableLanguageClient): void {
    for (const doc of vscode.workspace.textDocuments) {
        if (isClangdFiltered(doc)) clearClientDiagnostics(client, doc.uri);
    }
}

async function closeAlreadyOpenFilteredDocuments(client: MutableLanguageClient): Promise<void> {
    const docs = vscode.workspace.textDocuments.filter(isClangdFiltered);
    if (docs.length === 0) return;

    const sendNotification = client.sendNotification?.bind(client);
    log(`closing ${docs.length} already-open filtered document(s) in clangd`);
    for (const doc of docs) {
        if (sendNotification) {
            try {
                await sendNotification(DID_CLOSE_TEXT_DOCUMENT, {
                    textDocument: { uri: doc.uri.toString() },
                });
                log(`sent didClose ${doc.uri.toString()}`);
            } catch (err) {
                log(`failed didClose ${doc.uri.toString()}: ${err instanceof Error ? err.message : String(err)}`);
            }
        } else {
            log('cannot close already-open filtered documents; language client has no sendNotification');
        }
        clearClientDiagnostics(client, doc.uri);
    }
}

function scheduleDelayedDiagnosticsClear(client: MutableLanguageClient): void {
    for (const delay of POST_CLOSE_DIAGNOSTIC_CLEAR_DELAYS_MS) {
        setTimeout(() => clearAlreadyOpenFilteredDiagnostics(client), delay);
    }
}

class Notifier implements vscode.Disposable {
    private statusBar: vscode.StatusBarItem;
    private diagnostics: vscode.DiagnosticCollection;
    private banner: vscode.TextEditorDecorationType;
    private toastShown = new Set<string>();
    private subs: vscode.Disposable[] = [];

    constructor() {
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBar.text = '$(circle-slash) clangd: not indexed';
        this.statusBar.tooltip = new vscode.MarkdownString(
            '**File is outside any workspace folder.**\n\n' +
            'clangd is not indexing it, so completion, navigation and diagnostics are unavailable.\n\n' +
            'Open a folder that contains the file to enable language features.',
        );
        this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

        this.diagnostics = vscode.languages.createDiagnosticCollection('clangd-filter-files');

        this.banner = vscode.window.createTextEditorDecorationType({
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
            overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
            overviewRulerLane: vscode.OverviewRulerLane.Full,
            after: {
                contentText: '⚠  Outside workspace — clangd is not indexing this file',
                color: new vscode.ThemeColor('editorWarning.foreground'),
                backgroundColor: new vscode.ThemeColor('inputValidation.warningBackground'),
                fontWeight: 'bold',
                margin: '0 0 0 2em',
            },
        });

        this.subs.push(
            this.statusBar,
            this.diagnostics,
            this.banner,
            vscode.window.onDidChangeActiveTextEditor((e) => this.refreshStatusBar(e)),
            vscode.window.onDidChangeVisibleTextEditors(() => this.refreshBanner()),
            vscode.window.onDidChangeTextEditorVisibleRanges((e) => this.applyBanner(e.textEditor, e.visibleRanges)),
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (!this.cfg().banner) return;
                for (const editor of vscode.window.visibleTextEditors) {
                    if (editor.document === e.document) this.applyBanner(editor);
                }
            }),
            vscode.workspace.onDidOpenTextDocument((d) => this.onOpen(d)),
            vscode.workspace.onDidCloseTextDocument((d) => {
                this.diagnostics.delete(d.uri);
                this.toastShown.delete(d.uri.toString());
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshAll()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('clangd-filter-files')) this.refreshAll();
                else if (e.affectsConfiguration('editor.stickyScroll')) this.refreshBanner();
            }),
        );

        this.refreshAll();
    }

    private cfg() {
        const c = vscode.workspace.getConfiguration('clangd-filter-files');
        return {
            statusBar: c.get<boolean>('notify.statusBar', true),
            toast: c.get<boolean>('notify.toast', false),
            diagnostic: c.get<boolean>('notify.diagnostic', false),
            banner: c.get<boolean>('notify.banner', false),
        };
    }

    private onOpen(doc: vscode.TextDocument): void {
        if (!isClangdFiltered(doc)) return;
        const cfg = this.cfg();
        const key = doc.uri.toString();

        if (cfg.toast && !this.toastShown.has(key)) {
            this.toastShown.add(key);
            vscode.window.showWarningMessage(
                `clangd: '${vscode.workspace.asRelativePath(doc.uri)}' is outside any workspace folder and will not be indexed.`,
            );
        }
        if (cfg.diagnostic) this.setDiagnostic(doc);
    }

    private setDiagnostic(doc: vscode.TextDocument): void {
        const diag = new vscode.Diagnostic(
            new vscode.Range(0, 0, 0, Math.max(0, doc.lineAt(0).text.length)),
            'File is outside any workspace folder; not indexed by clangd.',
            vscode.DiagnosticSeverity.Information,
        );
        diag.source = 'clangd-filter-files';
        this.diagnostics.set(doc.uri, [diag]);
    }

    private refreshStatusBar(editor: vscode.TextEditor | undefined): void {
        const cfg = this.cfg();
        if (cfg.statusBar && editor && isClangdFiltered(editor.document)) {
            this.statusBar.show();
        } else {
            this.statusBar.hide();
        }
    }

    private bannerOffset(topLine: number): number {
        const ed = vscode.workspace.getConfiguration('editor');
        const stickyEnabled = ed.get<boolean>('stickyScroll.enabled', false);
        const stickyMax = ed.get<number>('stickyScroll.maxLineCount', 5);
        const sticky = stickyEnabled && topLine > 0 ? stickyMax : 0;
        const extra = vscode.workspace
            .getConfiguration('clangd-filter-files')
            .get<number>('notify.bannerExtraLineOffset', 0);
        return sticky + Math.max(0, extra);
    }

    private applyBanner(editor: vscode.TextEditor, visibleRanges?: readonly vscode.Range[]): void {
        if (!this.cfg().banner || !isClangdFiltered(editor.document)) {
            editor.setDecorations(this.banner, []);
            return;
        }
        const ranges = visibleRanges ?? editor.visibleRanges;
        const lastLine = editor.document.lineCount - 1;
        const topLine = Math.min(ranges[0]?.start.line ?? 0, lastLine);
        const target = Math.min(topLine + this.bannerOffset(topLine), lastLine);
        log(`banner @ line ${target + 1} (top ${topLine + 1}) of ${editor.document.uri.fsPath}`);
        const args = encodeURIComponent(JSON.stringify([editor.document.uri.toString()]));
        const hover = new vscode.MarkdownString(
            `**clangd: file not indexed**\n\n` +
            `This file is outside any workspace folder.\n\n` +
            `[Add containing folder to workspace](command:clangd-filter-files.addParentFolder?${args})`,
        );
        hover.isTrusted = true;
        editor.setDecorations(this.banner, [{
            range: editor.document.lineAt(target).range,
            hoverMessage: hover,
        }]);
    }

    private refreshBanner(): void {
        for (const editor of vscode.window.visibleTextEditors) this.applyBanner(editor);
    }

    private refreshAll(): void {
        this.refreshStatusBar(vscode.window.activeTextEditor);
        this.refreshBanner();
        this.diagnostics.clear();
        if (this.cfg().diagnostic) {
            for (const doc of vscode.workspace.textDocuments) {
                if (isClangdFiltered(doc)) this.setDiagnostic(doc);
            }
        }
    }

    dispose(): void {
        this.subs.forEach((s) => s.dispose());
    }
}

function dropNotification(name: string, getUri: (arg: any) => vscode.Uri | undefined) {
    return async (data: any, next: (data: any) => Promise<void>) => {
        const uri = getUri(data);
        if (isOutsideWorkspace(uri)) {
            log(`drop ${name} ${uri?.toString()}`);
            return;
        }
        return next(data);
    };
}

function dropRequest<T extends any[], R>(
    name: string,
    getUri: (...args: T) => vscode.Uri | undefined,
    empty: R,
) {
    return (...args: [...T, (...a: T) => R]): R => {
        const uri = getUri(...(args.slice(0, -1) as unknown as T));
        if (isOutsideWorkspace(uri)) {
            log(`drop ${name} ${uri?.toString()}`);
            return empty;
        }
        const next = args[args.length - 1] as (...a: T) => R;
        return next(...(args.slice(0, -1) as unknown as T));
    };
}

function buildMiddleware(prev: Record<string, any>): Record<string, any> {
    const docUri = (d: vscode.TextDocument) => d.uri;
    const evtUri = (e: vscode.TextDocumentChangeEvent) => e.document.uri;
    const willSaveUri = (e: vscode.TextDocumentWillSaveEvent) => e.document.uri;
    const prevHandleDiagnostics = prev.handleDiagnostics;
    const prevProvideDiagnostics = prev.provideDiagnostics;
    const prevProvideWorkspaceDiagnostics = prev.provideWorkspaceDiagnostics;

    return {
        ...prev,
        [SENTINEL]: true,

        handleDiagnostics: (uri: vscode.Uri, diagnostics: vscode.Diagnostic[], next: any) => {
            if (isOutsideWorkspace(uri)) {
                log(`clear diagnostics ${uri.toString()}`);
                next(uri, []);
                return;
            }
            if (prevHandleDiagnostics) {
                prevHandleDiagnostics(uri, diagnostics, next);
                return;
            }
            next(uri, diagnostics);
        },

        provideDiagnostics: (document: vscode.TextDocument | vscode.Uri, previousResultId: string | undefined, token: vscode.CancellationToken, next: any) => {
            const uri = documentOrUriUri(document);
            if (isOutsideWorkspace(uri)) {
                log(`clear pull diagnostics ${uri.toString()}`);
                return emptyDiagnosticReport();
            }
            if (prevProvideDiagnostics) {
                return prevProvideDiagnostics(document, previousResultId, token, next);
            }
            return next(document, previousResultId, token);
        },

        provideWorkspaceDiagnostics: (resultIds: any[], token: vscode.CancellationToken, resultReporter: any, next: any) => {
            const filteredResultIds = resultIds.filter((result) => !isOutsideWorkspace(result.uri));
            const filteredReporter = (chunk: any) => resultReporter(filterWorkspaceDiagnosticReport(chunk));
            const result = prevProvideWorkspaceDiagnostics
                ? prevProvideWorkspaceDiagnostics(filteredResultIds, token, filteredReporter, next)
                : next(filteredResultIds, token, filteredReporter);
            return Promise.resolve(result).then(filterWorkspaceDiagnosticReport);
        },

        didOpen: dropNotification('didOpen', docUri),
        didChange: dropNotification('didChange', evtUri),
        didSave: dropNotification('didSave', docUri),
        didClose: dropNotification('didClose', docUri),
        willSave: dropNotification('willSave', willSaveUri),
        willSaveWaitUntil: async (event: vscode.TextDocumentWillSaveEvent, next: any) => {
            if (isOutsideWorkspace(event.document.uri)) return [];
            return next(event);
        },

        provideHover: dropRequest('hover', (d: vscode.TextDocument) => d.uri, null),
        provideDefinition: dropRequest('definition', (d: vscode.TextDocument) => d.uri, null),
        provideTypeDefinition: dropRequest('typeDefinition', (d: vscode.TextDocument) => d.uri, null),
        provideImplementation: dropRequest('implementation', (d: vscode.TextDocument) => d.uri, null),
        provideReferences: dropRequest('references', (d: vscode.TextDocument) => d.uri, null),
        provideDocumentHighlights: dropRequest('documentHighlights', (d: vscode.TextDocument) => d.uri, null),
        provideDocumentSymbols: dropRequest('documentSymbols', (d: vscode.TextDocument) => d.uri, null),
        provideCodeActions: dropRequest('codeActions', (d: vscode.TextDocument) => d.uri, null),
        provideCodeLenses: dropRequest('codeLenses', (d: vscode.TextDocument) => d.uri, null),
        resolveCodeLens: (lens: any, token: any, next: any) => next(lens, token),
        provideDocumentFormattingEdits: dropRequest('formatting', (d: vscode.TextDocument) => d.uri, null),
        provideDocumentRangeFormattingEdits: dropRequest('rangeFormatting', (d: vscode.TextDocument) => d.uri, null),
        provideOnTypeFormattingEdits: dropRequest('onTypeFormatting', (d: vscode.TextDocument) => d.uri, null),
        provideRenameEdits: dropRequest('rename', (d: vscode.TextDocument) => d.uri, null),
        prepareRename: dropRequest('prepareRename', (d: vscode.TextDocument) => d.uri, null),
        provideCompletionItem: dropRequest('completion', (d: vscode.TextDocument) => d.uri, null),
        resolveCompletionItem: (item: any, token: any, next: any) => next(item, token),
        provideSignatureHelp: dropRequest('signatureHelp', (d: vscode.TextDocument) => d.uri, null),
        provideFoldingRanges: dropRequest('foldingRanges', (d: vscode.TextDocument) => d.uri, null),
        provideSelectionRanges: dropRequest('selectionRanges', (d: vscode.TextDocument) => d.uri, null),
        provideDocumentSemanticTokens: dropRequest('semanticTokens', (d: vscode.TextDocument) => d.uri, null),
        provideDocumentSemanticTokensEdits: dropRequest('semanticTokensEdits', (d: vscode.TextDocument) => d.uri, null),
        provideDocumentRangeSemanticTokens: dropRequest('semanticTokensRange', (d: vscode.TextDocument) => d.uri, null),
        provideInlayHints: dropRequest('inlayHints', (d: vscode.TextDocument) => d.uri, null),
        provideCallHierarchy: dropRequest('callHierarchy', (d: vscode.TextDocument) => d.uri, null),
        prepareTypeHierarchy: dropRequest('typeHierarchy', (d: vscode.TextDocument) => d.uri, null),
        provideLinkedEditingRange: dropRequest('linkedEditingRange', (d: vscode.TextDocument) => d.uri, null),
        provideDocumentLinks: dropRequest('documentLinks', (d: vscode.TextDocument) => d.uri, null),
        provideColorPresentations: (color: any, context: any, token: any, next: any) => {
            if (isOutsideWorkspace(context?.document?.uri)) return null;
            return next(color, context, token);
        },
        provideDocumentColors: dropRequest('documentColors', (d: vscode.TextDocument) => d.uri, null),
    };
}

let attachedClient: MutableLanguageClient | undefined;
let stateSub: vscode.Disposable | undefined;

function install(client: MutableLanguageClient): void {
    const opts = client.clientOptions ?? ((client as any).clientOptions = {});
    const prev = opts.middleware ?? {};
    if (prev[SENTINEL]) {
        attachedClient = client;
        log('middleware already installed');
        return;
    }
    opts.middleware = buildMiddleware(prev);
    attachedClient = client;
    log('middleware installed');
}

async function getExtension(): Promise<vscode.Extension<ClangdExtension> | undefined> {
    const ext = vscode.extensions.getExtension<ClangdExtension>(CLANGD_EXTENSION_ID);
    if (!ext) {
        vscode.window.showErrorMessage(
            `vscode-clangd-filter-files: required extension '${CLANGD_EXTENSION_ID}' not found.`,
        );
        return undefined;
    }
    if (!ext.isActive) await ext.activate();
    return ext;
}

const REATTACH_POLL_MS = 200;
const REATTACH_MAX_ATTEMPTS = 50;

function retryAttach(ext: vscode.Extension<ClangdExtension>, attempt: number): void {
    if (attempt < REATTACH_MAX_ATTEMPTS) {
        setTimeout(() => attach(ext, attempt + 1), REATTACH_POLL_MS);
    } else {
        log('giving up reattach; use clangd-filter-files.reattach to retry');
    }
}

function attach(ext: vscode.Extension<ClangdExtension>, attempt = 0): void {
    const client = ext.exports.getApi(1).languageClient;
    if (!client || client.state === LCState.Stopped) {
        retryAttach(ext, attempt);
        return;
    }

    if (client === attachedClient) {
        return;
    }

    stateSub?.dispose();
    stateSub = undefined;

    install(client);

    let closedAlreadyOpenDocs = false;
    const closeAlreadyOpenDocs = () => {
        if (closedAlreadyOpenDocs || client.state !== LCState.Running) return;
        closedAlreadyOpenDocs = true;
        void closeAlreadyOpenFilteredDocuments(client);
        scheduleDelayedDiagnosticsClear(client);
    };

    closeAlreadyOpenDocs();

    stateSub = client.onDidChangeState(({ newState }) => {
        if (newState === LCState.Running) closeAlreadyOpenDocs();
        if (newState !== LCState.Stopped) return;
        log('language client stopped; awaiting new instance');
        stateSub?.dispose();
        stateSub = undefined;
        attachedClient = undefined;
        attach(ext);
    });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const ext = await getExtension();
    if (!ext) return;

    attach(ext);

    context.subscriptions.push(
        new Notifier(),
        { dispose: () => stateSub?.dispose() },
        vscode.commands.registerCommand('clangd-filter-files.addParentFolder', async (uriStr?: string) => {
            const target = uriStr
                ? vscode.Uri.parse(uriStr)
                : vscode.window.activeTextEditor?.document.uri;
            if (!target) return;
            const parent = vscode.Uri.joinPath(target, '..');
            const existing = vscode.workspace.workspaceFolders ?? [];
            const already = existing.some((f) => f.uri.toString() === parent.toString());
            if (already) {
                vscode.window.showInformationMessage(
                    `'${parent.fsPath}' is already a workspace folder.`,
                );
                return;
            }
            vscode.workspace.updateWorkspaceFolders(existing.length, 0, { uri: parent });
        }),
        vscode.commands.registerCommand('clangd-filter-files.reattach', () => {
            attachedClient = undefined;
            attach(ext);
            vscode.window.showInformationMessage(
                attachedClient
                    ? 'clangd filter middleware reattached.'
                    : 'clangd language client is not running.',
            );
        }),
    );
}

export function deactivate(): void {
    stateSub?.dispose();
    logChannel?.dispose();
}
