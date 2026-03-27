import * as vscode from 'vscode';

export interface CommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    command: string;
    duration: number;
}

export interface BackgroundProcess {
    id: string;
    command: string;
    terminal: vscode.Terminal;
    startedAt: Date;
}

export class TerminalProvider {
    private backgroundProcesses: Map<string, BackgroundProcess> = new Map();
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('OmniCode Terminal');
    }

    async runCommand(command: string, options: CommandOptions = {}): Promise<CommandResult> {
        const startTime = Date.now();
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const cwd = options.cwd || workspaceFolder?.uri.fsPath;

        this.validateCommand(command);

        return new Promise((resolve, reject) => {
            const { spawn } = require('child_process');
            
            const isWindows = process.platform === 'win32';
            const shell = isWindows ? 'cmd.exe' : '/bin/sh';
            const shellFlag = isWindows ? '/c' : '-c';

            const child = spawn(shell, [shellFlag, command], {
                cwd,
                env: { ...process.env, ...options.env },
                timeout: options.timeout || 60000
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data: Buffer) => {
                const text = data.toString();
                stdout += text;
                this.outputChannel.append(text);
            });

            child.stderr.on('data', (data: Buffer) => {
                const text = data.toString();
                stderr += text;
                this.outputChannel.append(text);
            });

            child.on('close', (code: number) => {
                const duration = Date.now() - startTime;
                resolve({ exitCode: code ?? 0, stdout, stderr, command, duration });
            });

            child.on('error', (error: Error) => {
                reject(new Error(`Command failed: ${error.message}`));
            });

            if (options.timeout) {
                setTimeout(() => {
                    child.kill();
                    reject(new Error(`Command timed out after ${options.timeout}ms`));
                }, options.timeout);
            }
        });
    }

    async runInBackground(command: string, options: BackgroundOptions = {}): Promise<string> {
        this.validateCommand(command);

        const id = `proc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const name = options.name || `OmniCode: ${command.substring(0, 30)}...`;

        const terminal = vscode.window.createTerminal({ name, cwd: options.cwd, env: options.env });
        terminal.sendText(command);
        
        if (!options.hidden) {
            terminal.show();
        }

        this.backgroundProcesses.set(id, { id, command, terminal, startedAt: new Date() });

        const disposable = vscode.window.onDidCloseTerminal(closedTerminal => {
            if (closedTerminal === terminal) {
                this.backgroundProcesses.delete(id);
                disposable.dispose();
            }
        });

        return id;
    }

    killProcess(processId: string): boolean {
        const process = this.backgroundProcesses.get(processId);
        if (!process) return false;

        process.terminal.dispose();
        this.backgroundProcesses.delete(processId);
        return true;
    }

    listBackgroundProcesses(): BackgroundProcessInfo[] {
        return Array.from(this.backgroundProcesses.values()).map(p => ({
            id: p.id,
            command: p.command,
            startedAt: p.startedAt.toISOString(),
            runningFor: Date.now() - p.startedAt.getTime()
        }));
    }

    private validateCommand(command: string): void {
        const blockedPatterns = [
            /rm\s+(-rf?|--recursive)?\s*[\/~]/i,
            /del\s+\/[sf]/i,
            /format\s+[a-z]:/i,
            /mkfs/i,
            /dd\s+if=/i,
            />\s*\/dev\/sd[a-z]/i,
            /curl.*\|\s*(ba)?sh/i,
            /wget.*\|\s*(ba)?sh/i,
            /shutdown/i,
            /reboot/i,
            /passwd/i,
            /useradd|adduser/i,
            /chmod\s+777/i,
            /chown\s+.*:/i
        ];
        
        for (const pattern of blockedPatterns) {
            if (pattern.test(command)) {
                throw new Error(`Blocked dangerous command pattern: ${command.substring(0, 50)}...`);
            }
        }
    }

    showOutput(): void {
        this.outputChannel.show();
    }

    dispose(): void {
        for (const process of this.backgroundProcesses.values()) {
            process.terminal.dispose();
        }
        this.backgroundProcesses.clear();
        this.outputChannel.dispose();
    }
}

export interface CommandOptions {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
}

export interface BackgroundOptions {
    cwd?: string;
    env?: Record<string, string>;
    name?: string;
    hidden?: boolean;
}

export interface BackgroundProcessInfo {
    id: string;
    command: string;
    startedAt: string;
    runningFor: number;
}
