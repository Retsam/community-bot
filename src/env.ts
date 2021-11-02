import dotenv from 'dotenv-safe';
dotenv.config();

export const token = process.env.TOKEN!;
export const botAdmins = process.env.BOT_ADMINS!.split(',');

export const autorole = process.env.AUTOROLE!.split(',').map(x => {
	const [msgID, roleID, emoji, autoRemove] = x.split(':');
	return {
		msgID,
		roleID,
		emoji,
		autoRemove: autoRemove == 'true',
	};
});

export const dbUrl = process.env.DATABASE_URL!;

export const helpCategory = process.env.HELP_CATEGORY!;

export const trustedRoleId = process.env.TRUSTED_ROLE_ID!;

export const rulesChannelId = process.env.RULES_CHANNEL!;

export const TS_BLUE = '#007ACC';
export const GREEN = '#77b155';
// Picked from Discord's "hourglass" emoji (in ⌛ | Occupied Help Channels)
export const HOURGLASS_ORANGE = '#ffa647';
// Picked from Discord's :ballot_box_with_check: emoji (☑)
export const BALLOT_BOX_BLUE = '#066696';
// Picked from Discord's blockquote line
export const BLOCKQUOTE_GREY = '#4f545c';

export const timeBeforeHelperPing = parseInt(
	process.env.TIME_BEFORE_HELPER_PING!,
);
