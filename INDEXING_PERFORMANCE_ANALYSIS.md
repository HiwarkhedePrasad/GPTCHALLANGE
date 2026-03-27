# Indexing Performance Analysis

## Problem
Indexing takes **5 minutes** in VS Code extension vs **10 seconds** on GitNexus website.

## Root Causes

### 1. **Different Architectures**
- **GitNexus Web**: Files pre-loaded in memory from ZIP → Fast in-memory processing
- **VS Code Extension**: Reading from disk repeatedly → Slow I/O operations

### 2. **Regex vs Tree-sitter**
- **GitNexus**: Uses Tree-sitter WASM for accurate AST parsing
- **Your Extension**: Uses regex pattern matching (slower & less accurate)

### 3. **Processing Phases**
Your extension does **6 full phases** sequentially:
1. Structure scanning
2. Symbol parsing (regex-based)
3. Import resolution  
4. Call analysis
5. Community detection
6. Process tracing

**This is overkill for initial graph display!**

## Solutions

### Option 1: Fast Initial Index (RECOMMENDED)
Do a **lightweight 2-phase index** first:
1. **Structure** only (files/folders) - takes <1 second
2. **Lazy symbol parsing** - parse files on-demand when user clicks

```typescript
// Fast mode: Just structure
const fastGraph = await indexerService.indexStructureOnly();
graphView.updateGraph(fastGraph); // Shows immediately!

// Background: Full index
indexerService.indexFullAsync().then(fullGraph => {
  graphView.updateGraph(fullGraph); // Updates when ready
});
```

### Option 2: Incremental Indexing
- Index visible files first
- Index rest in background
- Use VS Code's file watcher for updates

### Option 3: Use VS Code's Built-in Language Server
- Don't parse files yourself!
- Use `vscode.languages.get

SymbolInformation()`
- It's already parsed by TypeScript/Python language servers

## Recommended Implementation

### Phase 1: Instant Structure (< 1 second)
```typescript
async indexStructureOnly(): Promise<KnowledgeGraph> {
  const files = await this.fsWalker.walk(rootPath);
  const structure = this.structureProcessor.process(files);
  
  return {
    nodes: structure.nodes,
    edges: structure.edges,
    clusters: [],
    metadata: { fileCount: files.length }
  };
}
```

### Phase 2: Background Symbol Indexing
```typescript
async indexSymbolsInBackground(onProgress) {
  // Parse files in chunks
  for (let i = 0; i < files.length; i += 100) {
    const batch = files.slice(i, i + 100);
    await this.parseBatch(batch);
    onProgress(i / files.length);
    
    // Yield to UI
    await new Promise(r => setTimeout(r, 0));
  }
}
```

### Phase 3: On-Demand Deep Analysis
```typescript
// Only run when user requests it
async analyzeCallGraph(fileOrSymbol: string) {
  // Analyze just this file's dependencies
}
```

## Performance Targets

| Phase | Current | Target |
|-------|---------|--------|
| Structure | ~30s | <1s |
| Symbols | ~2min | <5s (background) |
| Full Analysis | ~5min | On-demand only |

## Key Insight

**GitNexus website is fast because:**
1. Files already in memory (from ZIP)
2. Uses Tree-sitter WASM (fast, accurate)
3. Everything in Web Worker (non-blocking)

**Your extension is slow because:**
1. Repeated disk I/O
2. Regex parsing (slow, inaccurate)
3. Does ALL analysis upfront (unnecessary)

## Action Items

1. ✅ Add `indexStructureOnly()` method
2. ✅ Make symbol parsing optional/background
3. ✅ Show graph immediately with just structure
4. ✅ Update graph as symbols are parsed
5. ⚠️ Consider using VS Code's language servers instead of custom parsing
