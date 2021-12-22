import { CommandContext } from 'slash-create';
import ValidationError from '../errors/ValidationError';
import Log from '../utils/Log';

const ValidationModule = {
    async isValidCommand(commandContext: CommandContext): Promise<any> {
        switch (commandContext.subcommands[0]) {
            case 'create':
                return;
            case 'publish':
                return;
            case 'claim':
                return;
            case 'submit':
                return;
            case 'complete':
                return;
            case 'list':
                return list(commandContext);
            case 'delete':
                return;
            case 'help':
                return;
			case 'gm':
                return;
            default:
                throw new ValidationError(`${commandContext.user.mention} Command not recognized. Please try again.`);
        }
    },
};

export default ValidationModule;

const list = async (commandContext: CommandContext): Promise<any> => {
    switch (commandContext.options.list['list-type']) { 
    case 'CREATED_BY_ME':
        return;
	case 'CLAIMED_BY_ME':
		return;
    case 'CLAIMED_BY_ME_AND_COMPLETE':
        return;
	case 'DRAFTED_BY_ME':
		return;
	case 'OPEN':
		return;
	case 'IN_PROGRESS':
		return;
	default:
		Log.info('invalid list-type');
        throw new ValidationError('Please select a valid list-type from the command menu');
	}
}