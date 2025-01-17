import {
	command,
	default as CookiecordClient,
	Module,
	listener,
	CommonInhibitors,
	optional,
} from 'cookiecord';
import {
	Message,
	MessageEmbed,
	Guild,
	TextChannel,
	GuildMember,
	ChannelData,
	CategoryChannel,
	GuildManager,
	Channel,
} from 'discord.js';
import { HelpUser } from '../entities/HelpUser';
import {
	categories,
	TS_BLUE,
	GREEN,
	HOURGLASS_ORANGE,
	BALLOT_BOX_BLUE,
	askCooldownRoleId,
	channelNames,
	dormantChannelTimeout,
	dormantChannelLoop,
	askHelpChannelId,
	ongoingEmptyTimeout,
	trustedRoleId,
	dormantChannelTimeoutHours,
} from '../env';
import { isTrustedMember } from '../util/inhibitors';

// Embeds trim empty lines, and each line trims whitespace. However, sometimes
// we want those (e.g. to indent) => A braille pattern blank won't be trimmed.
// This is a hack, but it should work everywhere; it was tested on a system
// without even the fonts to display regular Discord emoji.
const u2800 = '⠀'; // https://www.compart.com/en/unicode/U+2800

const AVAILABLE_MESSAGE = `
Each help channel is reserved for one person at a time. See <#${askHelpChannelId}>
**Nobody is using this channel. Send your question here to reserve it.**
It's always ok to just ask your question; you don't need permission.

**For better & faster answers:**
• Explain what you want to happen and why…
${u2800}• …and what actually happens, and your best guess at why.
• Include a short code sample and error messages, if you got any.
${u2800}• Text is better than screenshots. Start code blocks with ${'```ts'}.
• If possible, create a minimal reproduction in the **[TypeScript Playground](https://www.typescriptlang.org/play)**.
${u2800}• Send the full link in its own message. Do not use a link shortener.

For more tips, check out StackOverflow's guide on **[asking good questions](https://stackoverflow.com/help/how-to-ask)**.
`;

const occupiedMessage = (asker: GuildMember) => `
Each help channel is reserved for one person at a time. See <#${askHelpChannelId}>
**${asker} is using this channel. Please try to help them, if you can!**
If you want help, please ask in an available channel instead.

**For better & faster answers:**
• Explain what you want to happen and why…
${u2800}• …and what actually happens, and your best guess at why.
• Include a short code sample and error messages, if you got any.
${u2800}• Text is better than screenshots. Start code blocks with ${'```ts'}.
• If possible, create a minimal reproduction in the **[TypeScript Playground](https://www.typescriptlang.org/play)**.
${u2800}• Send the full link in its own message. Do not use a link shortener.

For more tips, check out StackOverflow's guide on **[asking good questions](https://stackoverflow.com/help/how-to-ask)**.

Usually someone will try to answer and help solve the issue within a few hours. If not, and **if you have followed the bullets above**, you may ping the <@&${trustedRoleId}> role. Please allow extra time at night in America/Europe.
`;

const DORMANT_MESSAGE = `
This help channel has been marked as **dormant**, and has been moved into the **Help: Dormant** category at the bottom of the channel list. It is no longer possible to send messages in this channel until it becomes available again.

If your question wasn't answered yet, you can claim a new help channel from the **Help: Available** category by simply asking your question again. Consider rephrasing the question to maximize your chance of getting a good answer. If you're not sure how, have a look through [StackOverflow's guide on asking a good question](https://stackoverflow.com/help/how-to-ask)
`;

const helpMessage = (channels: Channel[]) => `
Help channels work a little differently on this server. So that people aren't talking over each other, only one person may ask for help in a channel at a time.
• Send a message to a help channel in the ":white_check_mark: | Available Help Channels" category (**currently ${channels.join(
	' and ',
)}**).
• Our bot will move your channel to ":hourglass: | Occupied Help Channels".
• Someone will (hopefully!) come along and help you.
• When your question(s) are resolved, type \`!close\`.

Help channels will be automatically closed after ${dormantChannelTimeoutHours} hours of inactivity. When a channel is closed, it moves into the ":zzz: | Dormant Help Channels" category to eventually be recycled back into the ":white_check_mark: | Available Help Channels" category.
`;

const helpChannelTopic = `One person may ask questions at a time. The current status is pinned. Details: <#${askHelpChannelId}>`;

export class HelpChanModule extends Module {
	constructor(client: CookiecordClient) {
		super(client);
	}

	CHANNEL_PREFIX = 'help-';

	AVAILABLE_EMBED = new MessageEmbed()
		.setTitle('✅ Available help channel')
		.setColor(GREEN)
		.setDescription(AVAILABLE_MESSAGE)
		.setFooter(
			`Closes after ${dormantChannelTimeoutHours} hours of inactivity or when you send !close.`,
		);

	OCCUPIED_EMBED_BASE = new MessageEmbed()
		.setTitle('⌛ Occupied Help Channel')
		.setColor(HOURGLASS_ORANGE);

	occupiedEmbed(asker: GuildMember) {
		return new MessageEmbed(this.OCCUPIED_EMBED_BASE)
			.setDescription(occupiedMessage(asker))
			.setFooter(
				`Closes after ${dormantChannelTimeoutHours} hours of inactivity or when ${asker.displayName} sends !close.`,
			);
	}

	CLOSED_EMBED_BASE = new MessageEmbed()
		.setTitle('☑ Question Closed')
		.setColor(BALLOT_BOX_BLUE);

	closedEmbed(next: Message) {
		return new MessageEmbed(this.CLOSED_EMBED_BASE).setDescription(
			`[Jump to the next question](${next.url})`,
		);
	}

	DORMANT_EMBED = new MessageEmbed()
		.setTitle('💤 Dormant Help Channel')
		.setColor(TS_BLUE)
		.setDescription(DORMANT_MESSAGE);

	busyChannels: Set<string> = new Set(); // a lock to eliminate race conditions
	ongoingEmptyTimeouts: Map<string, NodeJS.Timeout> = new Map(); // a lock used to prevent multiple timeouts running on the same channel

	private getChannelName(guild: Guild) {
		const takenChannelNames = guild.channels.cache
			.filter(channel => channel.name.startsWith(this.CHANNEL_PREFIX))
			.map(channel => channel.name.replace(this.CHANNEL_PREFIX, ''));
		let decidedChannel = channelNames[0];

		do {
			decidedChannel =
				channelNames[Math.floor(Math.random() * channelNames.length)];
		} while (takenChannelNames.includes(decidedChannel));

		return `${this.CHANNEL_PREFIX}${decidedChannel}`;
	}

	private getOngoingChannels() {
		return this.client.channels.cache
			.filter(
				channel =>
					(channel as TextChannel).parentID === categories.ongoing,
			)
			.array() as TextChannel[];
	}

	@listener({ event: 'ready' })
	async startDormantLoop() {
		setInterval(() => {
			this.checkDormantPossibilities();
		}, dormantChannelLoop);
	}

	@listener({ event: 'ready' })
	async initialCheckEmptyOngoing() {
		for (const channel of this.getOngoingChannels()) {
			if (await this.checkEmptyOngoing(channel)) {
				await this.startEmptyTimeout(channel);
			}
		}
	}

	// Utility function used to check if there are no messages in an ongoing channel, meaning the bot
	// is the most recent message. This will be caused if somebody deletes their message after they
	// claim a channel.
	async checkEmptyOngoing(channel: TextChannel) {
		const messages = await channel.messages.fetch();

		const embed = messages.first()?.embeds[0];

		return (
			embed?.title &&
			embed.title.trim() === this.OCCUPIED_EMBED_BASE.title?.trim()
		);
	}

	async startEmptyTimeout(channel: TextChannel) {
		const existingTimeout = this.ongoingEmptyTimeouts.get(channel.id);
		if (existingTimeout) clearTimeout(existingTimeout);

		const timeout = setTimeout(async () => {
			this.ongoingEmptyTimeouts.delete(channel.id);

			if (await this.checkEmptyOngoing(channel)) {
				await this.markChannelAsDormant(channel);
			}
		}, ongoingEmptyTimeout);

		this.ongoingEmptyTimeouts.set(channel.id, timeout);
	}

	@listener({ event: 'messageDelete' })
	async onMessageDeleted(msg: Message) {
		if (
			msg.channel.type !== 'text' ||
			!msg.channel.parentID ||
			msg.channel.parentID !== categories.ongoing
		)
			return;

		await this.startEmptyTimeout(msg.channel);
	}

	async moveChannel(channel: TextChannel, category: string) {
		const parent = channel.guild.channels.resolve(category);
		if (parent == null || !(parent instanceof CategoryChannel)) return;
		const data: ChannelData = {
			parentID: parent.id,
			permissionOverwrites: parent.permissionOverwrites,
		};
		channel = await channel.edit(data);
		channel = (await channel.fetch()) as TextChannel;
		await channel.setPosition(
			((await channel.parent!.fetch()) as CategoryChannel).children.size -
				1,
		);
	}

	@listener({ event: 'message' })
	async onNewQuestion(msg: Message) {
		if (
			msg.author.bot ||
			!msg.guild ||
			!msg.member ||
			msg.channel.type !== 'text' ||
			!msg.channel.parentID ||
			msg.channel.parentID !== categories.ask ||
			!msg.channel.name.startsWith(this.CHANNEL_PREFIX) ||
			this.busyChannels.has(msg.channel.id)
		)
			return;

		this.busyChannels.add(msg.channel.id);

		await Promise.all([
			this.updateStatusEmbed(msg.channel, this.occupiedEmbed(msg.member)),
			this.addCooldown(msg.member, msg.channel),
			this.moveChannel(msg.channel, categories.ongoing),
			msg.pin(),
		]);
		await this.ensureAskChannels(msg.guild);

		this.busyChannels.delete(msg.channel.id);
	}

	@listener({ event: 'message' })
	async onNewSystemPinMessage(msg: Message) {
		if (
			msg.type !== 'PINS_ADD' ||
			msg.channel.type !== 'text' ||
			!(
				msg.channel.parentID == categories.ask ||
				msg.channel.parentID == categories.ongoing ||
				msg.channel.parentID == categories.dormant
			)
		)
			return;
		await msg.delete({ reason: 'Pin system message' });
	}

	@command({
		aliases: ['close', 'closed', 'resolve', 'done'],
		description: 'Help Channel: Marks this channel as resolved',
	})
	async resolved(msg: Message) {
		if (
			!(msg.channel instanceof TextChannel) ||
			!msg.guild ||
			this.busyChannels.has(msg.channel.id)
		)
			return;

		if (msg.channel.parentID !== categories.ongoing) {
			return await msg.channel.send(
				':warning: you can only run this in ongoing help channels.',
			);
		}

		const owner = await HelpUser.findOne({
			channelId: msg.channel.id,
		});

		if (
			(owner && owner.userId === msg.author.id) ||
			msg.member?.hasPermission('MANAGE_MESSAGES')
		) {
			await this.markChannelAsDormant(msg.channel);
		} else {
			return await msg.channel.send(
				':warning: you have to be the asker to close the channel.',
			);
		}
	}

	getAvailableChannels(guild: Guild) {
		return guild.channels.cache
			.filter(channel => channel.parentID == categories.ask)
			.filter(channel => channel.name.startsWith(this.CHANNEL_PREFIX));
	}

	async ensureAskChannels(guild: Guild) {
		while (this.getAvailableChannels(guild).size !== 2) {
			const dormant = guild.channels.cache.find(
				x => x.parentID == categories.dormant,
			);
			if (dormant && dormant instanceof TextChannel) {
				await this.moveChannel(dormant, categories.ask);
				const msg =
					(await this.updateStatusEmbed(
						dormant,
						this.AVAILABLE_EMBED,
					)) ?? (await dormant.send(this.AVAILABLE_EMBED));
				// Temporary -- on first deploy, old statuses won't be pinned,
				// so the update will create a new one instead; pin it!
				if (!msg.pinned) await msg.pin();
			} else {
				const chan = await guild.channels.create(
					this.getChannelName(guild),
					{
						type: 'text',
						topic: helpChannelTopic,
						reason: 'maintain help channel goal',
						parent: categories.ask,
					},
				);

				// Channel should already be in ask, but sync the permissions.
				await this.moveChannel(chan, categories.ask);
				await chan.send(this.AVAILABLE_EMBED).then(msg => msg.pin());
			}
		}
		await this.updateHelpMessage(guild);
	}

	async updateHelpMessage(guild: Guild) {
		const askHelpChannel = guild.channels.cache.get(askHelpChannelId);
		if (!askHelpChannel || !(askHelpChannel instanceof TextChannel)) return;
		const availableChannels = this.getAvailableChannels(guild).array();
		const newMessageText = helpMessage(availableChannels);
		const lastMessage =
			askHelpChannel.lastMessage ??
			(await askHelpChannel.messages.fetch({ limit: 1 })).array()[0];
		if (lastMessage?.author.id === this.client.user!.id)
			lastMessage.edit(newMessageText);
		else askHelpChannel.send(newMessageText);
	}

	private async getChannelMember(channel: TextChannel) {
		return (
			HelpUser.findOneOrFail({
				channelId: channel.id,
			})
				.then(helpUser => {
					// Clear from the cache in case they've left the server
					channel.guild.members.cache.delete(helpUser.userId);
					return channel.guild.members.fetch({
						user: helpUser.userId,
					});
				})
				// Do nothing, member left the guild
				.catch(() => undefined)
		);
	}

	private async markChannelAsDormant(channel: TextChannel) {
		this.busyChannels.add(channel.id);

		const memberPromise = this.getChannelMember(channel);

		const pinnedPromise = channel.messages.fetchPinned();

		const newStatusPromise = this.moveChannel(
			channel,
			categories.dormant,
		).then(() => channel.send(this.DORMANT_EMBED));

		await Promise.all([
			memberPromise,
			pinnedPromise,
			newStatusPromise,
		]).then(([member, pinned, newStatus]) =>
			Promise.all<unknown>([
				this.updateStatusEmbed(
					channel,
					this.closedEmbed(newStatus),
					pinned.array(),
				),
				...pinned
					.filter(m => m.id !== newStatus.id)
					.map(msg => msg.unpin()),
				newStatus.pin(),
				HelpUser.delete({ channelId: channel.id }),
				member?.roles.remove(askCooldownRoleId),
			]),
		);

		await this.ensureAskChannels(channel.guild);
		this.busyChannels.delete(channel.id);
	}

	private async checkDormantPossibilities() {
		for (const channel of this.getOngoingChannels()) {
			const [messages, member] = await Promise.all([
				channel.messages.fetch(),
				this.getChannelMember(channel),
			]);

			const diff =
				Date.now() - (messages.first()?.createdAt.getTime() ?? 0);

			if (!member) {
				await channel.send(
					'Asker has left the server, closing channel...',
				);
			}
			if (!member || diff > dormantChannelTimeout) {
				await this.markChannelAsDormant(channel);
				continue;
			}
		}
	}

	private async updateStatusEmbed(
		channel: TextChannel,
		embed: MessageEmbed,
		pinned?: Message[],
	) {
		const isStatusEmbed = (embed: MessageEmbed) =>
			[
				this.AVAILABLE_EMBED.title,
				this.OCCUPIED_EMBED_BASE.title,
				this.DORMANT_EMBED.title,
			].includes(embed.title);

		if (!pinned) pinned = (await channel.messages.fetchPinned()).array();

		// There should be only one pinned message, the latest status message.
		// However, to transition to this new behavior, and just in case someone
		// accidentally pins a message, we sort & find the most recent status.
		const lastMessage = pinned
			.filter(m => m.author && m.author.id === this.client.user?.id)
			.sort((m1, m2) => m2.createdTimestamp - m1.createdTimestamp)
			.find(m => m.embeds.some(isStatusEmbed));

		// If there is a last status message, edit it. Otherwise, send a new message.
		return await lastMessage?.edit(embed);
	}

	private async addCooldown(member: GuildMember, channel: TextChannel) {
		await member.roles.add(askCooldownRoleId);
		const helpUser = new HelpUser();
		helpUser.userId = member.user.id;
		helpUser.channelId = channel.id;
		await helpUser.save();
	}

	@command({
		inhibitors: [CommonInhibitors.guildsOnly],
		aliases: ['claimed'],
		description: 'Help Channel: Check if a user has an open help channel',
	})
	async cooldown(msg: Message, @optional member?: GuildMember) {
		const guildTarget = await msg.guild!.members.fetch(
			member ?? msg.author,
		);

		if (!guildTarget) return;

		if (!guildTarget.roles.cache.has(askCooldownRoleId)) {
			await msg.channel.send(`${guildTarget} doesn't have a cooldown.`);
			return;
		}

		const helpUser = await HelpUser.findOne({
			userId: guildTarget.id,
		});

		if (helpUser) {
			return msg.channel.send(
				`${guildTarget} has an active help channel: <#${helpUser.channelId}>`,
			);
		}

		await guildTarget.roles.remove(askCooldownRoleId);
		await msg.channel.send(`Removed ${guildTarget}'s cooldown.`);
	}

	@command({
		inhibitors: [isTrustedMember],
		description: "Help Channel: Claim a help channel for a user's question",
	})
	async claim(msg: Message, member: GuildMember) {
		const helpUser = await HelpUser.findOne({
			userId: member.id,
		});
		if (helpUser) {
			await msg.channel.send(
				`${member.displayName} already has an open help channel: <#${helpUser.channelId}>`,
			);
			return;
		}

		const channelMessages = await msg.channel.messages.fetch({ limit: 50 });
		const questionMessages = channelMessages.filter(
			questionMsg =>
				questionMsg.author.id === member.id &&
				questionMsg.id !== msg.id,
		);

		const msgContent = questionMessages
			.array()
			.slice(0, 10)
			.map(msg => msg.content)
			.reverse()
			.join('\n')
			.slice(0, 2000);

		const claimedChannel = msg.guild!.channels.cache.find(
			channel =>
				channel.type === 'text' &&
				channel.parentID == categories.ask &&
				channel.name.startsWith(this.CHANNEL_PREFIX) &&
				!this.busyChannels.has(channel.id),
		) as TextChannel | undefined;

		if (!claimedChannel) {
			await msg.channel.send(
				':warning: failed to claim a help channel, no available channel.',
			);
			return;
		}

		this.busyChannels.add(claimedChannel.id);

		const questionEmbed = new MessageEmbed()
			.setAuthor(member.displayName, member.user.displayAvatarURL())
			.setDescription(msgContent);

		await Promise.all([
			claimedChannel.send(questionEmbed).then(m => m.pin()),
			this.updateStatusEmbed(claimedChannel, this.occupiedEmbed(member)),
			this.addCooldown(member, claimedChannel),
			await this.moveChannel(claimedChannel, categories.ongoing),
		]);
		await claimedChannel.send(
			`${member.user} this channel has been claimed for your question. Please review <#${askHelpChannelId}> for how to get help.`,
		);
		await this.ensureAskChannels(msg.guild!);

		this.busyChannels.delete(claimedChannel.id);

		await msg.channel.send(`👌 successfully claimed ${claimedChannel}`);
	}

	// Commands to fix race conditions
	@command({
		inhibitors: [CommonInhibitors.hasGuildPermission('MANAGE_MESSAGES')],
	})
	async removelock(msg: Message) {
		this.busyChannels.delete(msg.channel.id);
		await msg.channel.send(':ok_hand:');
	}

	@command({
		inhibitors: [CommonInhibitors.hasGuildPermission('MANAGE_MESSAGES')],
	})
	async ensureAsk(msg: Message) {
		if (!msg.guild) return;

		await this.ensureAskChannels(msg.guild);
		await msg.channel.send(':ok_hand:');
	}

	getDormantChannels(guild: Guild) {
		return guild.channels.cache
			.filter(channel => channel.parentID == categories.dormant)
			.filter(channel => channel.name.startsWith(this.CHANNEL_PREFIX));
	}

	getOutdatedChannels(guild: Guild) {
		return this.getOngoingChannels()
			.concat(
				this.getAvailableChannels(guild).array() as TextChannel[],
				this.getDormantChannels(guild).array() as TextChannel[],
			)
			.filter(it => it.topic !== helpChannelTopic);
	}

	updateHelpChannelTopicsTimeout: NodeJS.Timeout | undefined = undefined;

	@command({
		inhibitors: [CommonInhibitors.hasGuildPermission('MANAGE_MESSAGES')],
	})
	async updateHelpChannelTopics(msg: Message) {
		const guild = msg.guild;
		if (!guild) return;

		const channels =
			this.getOutdatedChannels(guild)
				.map(it => it.toString())
				.join(', ') || 'None';

		if (this.updateHelpChannelTopicsTimeout !== undefined) {
			await msg.channel
				.send(`Updates already in progress. Cancel with: \`!stopUpdatingHelpChannelTopics\`
Remaining: ${channels}`);
			return;
		} else {
			await msg.channel.send(`Updating these channels: ${channels}`);
		}

		const updateLoop = async () => {
			const channel = this.getOutdatedChannels(guild)[0];
			if (channel) {
				this.updateHelpChannelTopicsTimeout = this.client.setTimeout(
					() => updateLoop(),
					20 * 60 * 1000, // 20 minute rate limit,
				);
				await channel.setTopic(
					helpChannelTopic,
					'Update outdated helpchan topic',
				);
			} else {
				this.updateHelpChannelTopicsTimeout = undefined;
			}
		};

		await updateLoop();
	}

	@command({
		inhibitors: [CommonInhibitors.hasGuildPermission('MANAGE_MESSAGES')],
	})
	async stopUpdatingHelpChannelTopics(msg: Message) {
		if (!msg.guild) return;

		if (this.updateHelpChannelTopicsTimeout === undefined) {
			await msg.channel.send('Not in progress!');
		} else {
			this.client.clearTimeout(this.updateHelpChannelTopicsTimeout);

			const channels =
				this.getOutdatedChannels(msg.guild)
					.map(it => it.toString())
					.join(', ') || 'None';

			await msg.channel.send(
				`Canceled help channel updates. Remaining: ${channels}`,
			);
		}
	}
}
