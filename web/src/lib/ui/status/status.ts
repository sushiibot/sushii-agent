import type { Component } from 'svelte';
import CircleAlert from '@lucide/svelte/icons/circle-alert';
import CircleCheck from '@lucide/svelte/icons/circle-check';
import CircleDashed from '@lucide/svelte/icons/circle-dashed';
import CircleX from '@lucide/svelte/icons/circle-x';
import Hand from '@lucide/svelte/icons/hand';
import LoaderCircle from '@lucide/svelte/icons/loader-circle';
import MessageSquareDot from '@lucide/svelte/icons/message-square-dot';
import Moon from '@lucide/svelte/icons/moon';
import ShieldAlert from '@lucide/svelte/icons/shield-alert';
import ShieldCheck from '@lucide/svelte/icons/shield-check';
import SkipForward from '@lucide/svelte/icons/skip-forward';
import Send from '@lucide/svelte/icons/send';
import VolumeX from '@lucide/svelte/icons/volume-x';
import Archive from '@lucide/svelte/icons/archive';
import PencilLine from '@lucide/svelte/icons/pencil-line';
import Hourglass from '@lucide/svelte/icons/hourglass';
import CircleStop from '@lucide/svelte/icons/circle-stop';
import TimerOff from '@lucide/svelte/icons/timer-off';

export type Tone = 'waiting' | 'running' | 'review' | 'failed' | 'taint' | 'neutral';

export interface StatusMeta {
	label: string;
	icon: Component;
	tone: Tone;
}

export const toneClass: Record<Tone, string> = {
	waiting: 'bg-waiting-soft text-waiting',
	running: 'bg-running-soft text-running',
	review: 'bg-review-soft text-review',
	failed: 'bg-failed-soft text-failed',
	taint: 'bg-taint-soft text-taint',
	neutral: 'bg-muted text-muted-foreground'
};

export const status = {
	waiting: { label: 'Waiting on you', icon: Hand, tone: 'waiting' },
	running: { label: 'Running', icon: LoaderCircle, tone: 'running' },
	review: { label: 'Inbox', icon: MessageSquareDot, tone: 'review' },
	failed: { label: 'Failed', icon: CircleX, tone: 'failed' },
	done: { label: 'Done', icon: CircleCheck, tone: 'neutral' },
	aborted: { label: 'Stopped', icon: CircleStop, tone: 'neutral' },
	timeout: { label: 'Timed out', icon: TimerOff, tone: 'failed' },
	verified: { label: 'Verified', icon: ShieldCheck, tone: 'review' },
	unverified: { label: 'Unverified', icon: ShieldAlert, tone: 'waiting' },
	tainted: { label: 'Read external content', icon: CircleAlert, tone: 'taint' },
	sent: { label: 'Sent', icon: Send, tone: 'review' },
	quiet: { label: 'Nothing new', icon: CircleDashed, tone: 'neutral' },
	suppressed: { label: 'Suppressed', icon: VolumeX, tone: 'neutral' },
	skipped: { label: 'Skipped', icon: SkipForward, tone: 'neutral' },
	'outside-hours': { label: 'Outside active hours', icon: Moon, tone: 'neutral' },
	draft: { label: 'Draft', icon: PencilLine, tone: 'running' },
	active: { label: 'Active', icon: CircleCheck, tone: 'review' },
	stale: { label: 'Stale', icon: Hourglass, tone: 'waiting' },
	archived: { label: 'Archived', icon: Archive, tone: 'neutral' }
} satisfies Record<string, StatusMeta>;

export type StatusKey = keyof typeof status;
