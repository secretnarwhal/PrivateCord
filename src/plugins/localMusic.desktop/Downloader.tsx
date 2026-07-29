/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { FormSwitch } from "@components/FormSwitch";
import { Span } from "@components/Span";
import { classes } from "@utils/misc";
import { formatDuration } from "@utils/text";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, TextInput, useEffect, useState } from "@webpack/common";

import { cl } from "./MiniPlayer";
import { store, usePlayer } from "./PlayerStore";
import { settings } from "./settings";
import type { DownloadJob, SearchResult, SearchSource, YtDlpInfo } from "./types";

const SEARCH_LIMIT = 25;

function isUrl(query: string) {
    return /^https?:\/\//i.test(query.trim());
}

/** Tells the user where yt-dlp was found, or why it wasn't. */
function YtDlpStatus({ info }: { info: YtDlpInfo | null; }) {
    if (!info) return <Span size="sm">Looking for yt-dlp…</Span>;

    if (!info.ok) return <Span size="sm" className={cl("dl-error")}>{info.error}</Span>;

    return <Span size="sm">yt-dlp {info.version} — {info.binary}</Span>;
}

function DownloadRow({ job }: { job: DownloadJob; }) {
    const running = job.status === "running";

    return (
        <div className={cl("dl-job")}>
            <div className={cl("dl-job-text")}>
                <span className={cl("row-title")} title={job.url}>{job.title}</span>
                <span className={classes(cl("row-subtitle"), job.status === "error" && cl("dl-error"))}>
                    {job.message}
                </span>
            </div>

            {running && (
                <div className={cl("dl-progress")}>
                    {/* yt-dlp reports no percentage while resolving or postprocessing */}
                    <div
                        className={classes(cl("dl-progress-fill"), job.percent < 0 && cl("dl-progress-idle"))}
                        style={{ width: job.percent < 0 ? "100%" : `${job.percent}%` }}
                    />
                </div>
            )}

            {running
                ? (
                    <Button size="small" variant="dangerSecondary" onClick={() => store.cancelDownload(job.id)}>
                        Cancel
                    </Button>
                )
                : <span className={cl("row-badge")}>{job.status.toUpperCase()}</span>}

            {/* every row can be dismissed on its own, whatever state it wound up in —
                a job that died without reporting back used to be unremovable */}
            <button
                className={cl("dl-dismiss")}
                aria-label="Remove from the list"
                title="Remove from the list"
                onClick={() => store.removeDownload(job.id)}
            >
                ✕
            </button>
        </div>
    );
}

function ResultRow({ result, onDownload }: { result: SearchResult; onDownload: (url: string) => void; }) {
    return (
        <div className={cl("row")}>
            {result.thumbnail
                ? <img className={cl("dl-thumb")} src={result.thumbnail} alt="" />
                : <div className={classes(cl("dl-thumb"), cl("art-placeholder"))} />}

            <div className={cl("row-text")}>
                <span className={cl("row-title")} title={result.title}>{result.title}</span>
                <span className={cl("row-subtitle")}>
                    {[result.uploader, result.duration ? formatDuration(result.duration * 1000) : null]
                        .filter(Boolean).join(" — ")}
                </span>
            </div>

            <Button size="small" variant="secondary" onClick={() => onDownload(result.url)}>
                Download
            </Button>
        </div>
    );
}

export function Downloader({ modalProps }: { modalProps: RenderModalProps; }) {
    const player = usePlayer();

    const [info, setInfo] = useState<YtDlpInfo | null>(null);
    const [query, setQuery] = useState("");
    const [source, setSource] = useState<SearchSource>("youtube");
    const [playlist, setPlaylist] = useState(false);
    const [results, setResults] = useState<SearchResult[]>([]);
    const [searching, setSearching] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        store.ytDlpInfo().then(setInfo, e => setInfo({ ok: false, binary: "yt-dlp", error: String(e) }));
    }, []);

    useEffect(() => {
        // progress arrives over the event stream, but a stream that dropped would
        // otherwise leave finished jobs frozen mid-download for as long as this is open
        store.refreshDownloads();
        const interval = window.setInterval(() => store.refreshDownloads(), 3000);

        return () => window.clearInterval(interval);
    }, []);

    // the browser queues downloads on its own, so it has to follow this toggle
    useEffect(() => void store.updateBrowserOptions(playlist), [playlist, player.folder]);

    async function runSearch() {
        if (!query.trim()) return;

        setSearching(true);
        setError(null);

        try {
            setResults(await player.search(query, source, SEARCH_LIMIT));
        } catch (e) {
            setResults([]);
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSearching(false);
        }
    }

    async function download(url: string) {
        setError(null);
        try {
            await player.startDownload(url, playlist);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }

    async function browse() {
        setError(null);
        try {
            await player.openBrowser(playlist, isUrl(query) ? query.trim() : "");
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }

    const active = player.downloads.filter(j => j.status === "running").length;
    const finished = player.downloads.length - active;

    return (
        <Modal {...modalProps} title="Download music" size="lg">
            <div className={cl("modal")}>
                <YtDlpStatus info={info} />

                <Span size="sm" className={cl("dl-target")}>
                    Saving to {player.folder ?? "— choose a folder in the library first"}
                </Span>

                <div className={cl("inline-row")}>
                    <Button
                        size="small"
                        variant={source === "youtube" ? "primary" : "secondary"}
                        onClick={() => setSource("youtube")}
                    >
                        YouTube
                    </Button>
                    <Button
                        size="small"
                        variant={source === "ytmusic" ? "primary" : "secondary"}
                        onClick={() => setSource("ytmusic")}
                    >
                        Music
                    </Button>

                    <div className={cl("dl-query")}>
                        <TextInput
                            value={query}
                            onChange={setQuery}
                            placeholder="Search, or paste a video / playlist URL"
                            onKeyDown={e => {
                                if (e.key !== "Enter") return;
                                if (isUrl(query)) download(query.trim());
                                else runSearch();
                            }}
                        />
                    </div>

                    {isUrl(query)
                        ? (
                            <Button
                                size="small"
                                disabled={!player.folder}
                                onClick={() => download(query.trim())}
                            >
                                Download
                            </Button>
                        )
                        : (
                            <Button size="small" disabled={searching || !query.trim()} onClick={runSearch}>
                                {searching ? "Searching…" : "Search"}
                            </Button>
                        )}

                    <Button size="small" variant="secondary" disabled={!player.folder} onClick={browse}>
                        Browse…
                    </Button>
                </div>

                <FormSwitch
                    hideBorder
                    title="Download whole playlists"
                    description="Off means a link that points into a playlist only fetches the one track"
                    value={playlist}
                    onChange={setPlaylist}
                />

                {error && <Span size="sm" className={cl("dl-error")}>{error}</Span>}

                {!!player.downloads.length && (
                    <>
                        <div className={cl("dl-heading")}>
                            <Span size="sm">Downloads{active ? ` — ${active} running` : ""}</Span>
                            <Button
                                size="small"
                                variant="secondary"
                                disabled={!finished}
                                onClick={() => player.clearFinishedDownloads()}
                            >
                                Clear finished
                            </Button>
                        </div>

                        <div className={cl("dl-jobs")}>
                            {player.downloads.map(job => <DownloadRow key={job.id} job={job} />)}
                        </div>
                    </>
                )}

                <div className={cl("list")}>
                    {results.map(result => (
                        <ResultRow key={result.id} result={result} onDownload={download} />
                    ))}

                    {!results.length && !searching && (
                        <Span size="sm">
                            Search YouTube, or paste any URL yt-dlp understands. <b>Browse…</b> opens YouTube
                            in its own window, where clicking a song queues it here instead of playing it.
                            Set a browser under <b>Read cookies from this browser</b> in the plugin settings
                            to reach your own playlists and Liked Music.
                        </Span>
                    )}
                </div>

                {settings.store.cookiesFromBrowser && (
                    <Span size="sm">
                        Using cookies from {settings.store.cookiesFromBrowser}. Your library lives at{" "}
                        <code>https://music.youtube.com/playlist?list=LM</code>
                    </Span>
                )}
            </div>
        </Modal>
    );
}
