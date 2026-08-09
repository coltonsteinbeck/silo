import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions
} from 'discord.js';
import type { RadioQueue, RadioTrack } from './types';

export const STALE_RADIO_CONTROLS_MESSAGE =
  'These radio controls are stale. Use the buttons on the current player.';

const NO_MENTIONS = { parse: [] as never[] };

const repeatLabel = (mode: RadioQueue['repeatMode']): string => {
  if (mode === 1) return '🔂 One';
  if (mode === 2) return '🔁 All';
  return '🔁 Off';
};

export function createRadioControls(
  hasPrevious: boolean,
  isPaused: boolean,
  repeatMode: RadioQueue['repeatMode']
): ActionRowBuilder<ButtonBuilder>[] {
  const primary = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('radio:pause')
      .setLabel(isPaused ? '▶️ Resume' : '⏸️ Pause')
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('radio:skip').setLabel('⏭️ Skip').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('radio:stop').setLabel('⏹️ Stop').setStyle(ButtonStyle.Danger)
  );

  const secondary = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('radio:queue')
      .setLabel('📋 Queue')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('radio:repeat')
      .setLabel(repeatLabel(repeatMode))
      .setStyle(repeatMode > 0 ? ButtonStyle.Success : ButtonStyle.Secondary)
  );
  if (hasPrevious) {
    secondary.addComponents(
      new ButtonBuilder()
        .setCustomId('radio:previous')
        .setLabel('⏮️ Previous')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  return [primary, secondary];
}

export function createNowPlayingEmbed(
  track: RadioTrack,
  queue: RadioQueue,
  isPlaying: boolean
): EmbedBuilder {
  const repeatIndicator = queue.repeatMode === 1 ? ' 🔂' : queue.repeatMode === 2 ? ' 🔁' : '';
  const title = isPlaying
    ? `${track.isSpotifyTrack ? '🎵 Now Playing (via Spotify)' : '🎵 Now Playing'}${repeatIndicator}`
    : `⏸️ Paused${repeatIndicator}`;
  const embed = new EmbedBuilder()
    .setColor(track.isSpotifyTrack ? '#1DB954' : isPlaying ? '#00ff00' : '#ff9900')
    .setTitle(title)
    .setDescription(`**${track.title}**`)
    .addFields(
      { name: '👤 Artist/Channel', value: track.channel || 'Unknown', inline: true },
      { name: '⏱️ Duration', value: track.duration || 'Unknown', inline: true },
      {
        name: '📋 Queue',
        value: `${queue.currentIndex + 1}/${queue.songs.length}`,
        inline: true
      }
    )
    .setTimestamp();

  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  if (track.isSpotifyTrack && track.originalSpotifyUrl) {
    embed.setFooter({ text: '🎵 Converted from Spotify • Playing via YouTube' });
  }
  if (queue.songs.length > 1) {
    const upcoming =
      queue.songs
        .slice(queue.currentIndex + 1, queue.currentIndex + 4)
        .map((song, index) => `${index + 1}. ${song.title}${song.isSpotifyTrack ? ' 🎵' : ''}`)
        .join('\n') || 'No upcoming songs';
    embed.addFields({ name: '🔜 Up Next', value: upcoming });
  }
  return embed;
}

export function createPersistentRadioPayload(
  queue: RadioQueue
): InteractionEditReplyOptions | null {
  if (queue.isFinished) {
    return {
      embeds: [
        new EmbedBuilder()
          .setColor('#ff9900')
          .setTitle('🔚 Queue Finished')
          .setDescription(
            'All songs have been played! Use `/radio` to add more music or the Stop button to disconnect.'
          )
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('radio:stop')
            .setLabel('⏹️ Disconnect')
            .setStyle(ButtonStyle.Danger)
        )
      ],
      allowedMentions: NO_MENTIONS
    };
  }

  const current = queue.songs[queue.currentIndex];
  if (!current) return null;
  return {
    embeds: [createNowPlayingEmbed(current, queue, !queue.isPaused)],
    components: createRadioControls(queue.currentIndex > 0, queue.isPaused, queue.repeatMode),
    allowedMentions: NO_MENTIONS
  };
}

export function createQueueOverview(queue: RadioQueue): InteractionReplyOptions {
  const current = queue.songs[queue.currentIndex];
  const previous = queue.songs.slice(0, queue.currentIndex);
  const upcoming = queue.songs.slice(queue.currentIndex + 1);
  const embed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle('📋 Current Queue')
    .addFields(
      {
        name: '📊 Queue Stats',
        value: `Total: ${queue.songs.length} songs\nPosition: ${queue.currentIndex + 1}/${queue.songs.length}`,
        inline: true
      },
      {
        name: '⏱️ Status',
        value: queue.isPaused ? '⏸️ Paused' : queue.isFinished ? '🔚 Finished' : '▶️ Playing',
        inline: true
      },
      {
        name: '🎵 Spotify Songs',
        value: String(queue.songs.filter(song => song.isSpotifyTrack).length),
        inline: true
      }
    )
    .setTimestamp();

  if (current) {
    embed.addFields({
      name: '🎵 Currently Playing',
      value: `**${current.title}**${current.isSpotifyTrack ? ' 🎵' : ''}\n*by ${current.channel || 'Unknown'}*`
    });
  }
  if (previous.length > 0) {
    embed.addFields({
      name: '⏮️ Recently Played',
      value: previous
        .slice(-3)
        .map((song, index, songs) => {
          const position = queue.currentIndex - songs.length + index + 1;
          return `${position}. ${song.title}${song.isSpotifyTrack ? ' 🎵' : ''}`;
        })
        .join('\n')
    });
  }
  if (upcoming.length > 0) {
    const visible = upcoming
      .slice(0, 8)
      .map(
        (song, index) =>
          `${queue.currentIndex + 2 + index}. ${song.title}${song.isSpotifyTrack ? ' 🎵' : ''}`
      )
      .join('\n');
    const more = upcoming.length > 8 ? `\n*...and ${upcoming.length - 8} more songs*` : '';
    embed.addFields({ name: '🔜 Up Next', value: `${visible}${more}` });
  } else if (!queue.isFinished) {
    embed.addFields({
      name: '🔜 Up Next',
      value: '*No more songs in queue*\nUse `/radio` to add more!'
    });
  }
  embed.setFooter({ text: '🎵 = Spotify Track • Use buttons to control playback' });

  return {
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
    allowedMentions: NO_MENTIONS
  };
}

export function createRadioStoppedPayload(): InteractionEditReplyOptions {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor('#ff0000')
        .setTitle('⏹️ Radio Stopped')
        .setDescription('Radio playback has been stopped and the queue cleared.')
    ],
    components: [],
    allowedMentions: NO_MENTIONS
  };
}

export function createRadioSessionChangedPayload(): InteractionEditReplyOptions {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor('#ff9900')
        .setTitle('Radio Session Changed')
        .setDescription(
          'This player no longer owns the active radio session. The newer queue was not stopped.'
        )
    ],
    components: [],
    allowedMentions: NO_MENTIONS
  };
}

export function createQueueAcknowledgement(
  label: string,
  queue: RadioQueue,
  startPosition: number,
  addedCount: number
): string {
  const current = queue.songs[queue.currentIndex];
  const upcomingCount = Math.max(0, queue.songs.length - queue.currentIndex - 1);
  const added =
    addedCount === 1
      ? `Added to queue at #${startPosition}`
      : `${addedCount} items added starting at #${startPosition}`;
  return [
    `✅ ${label}`,
    `${added} • ${upcomingCount} up next`,
    current ? `Now playing: **${current.title}**` : 'Now playing: Unknown',
    'Use the existing player controls above to manage playback.'
  ].join('\n');
}
