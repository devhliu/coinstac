import React from 'react'
import PropTypes from 'prop-types'
import classNames from 'classnames'
import { get, head, orderBy } from 'lodash'
import moment from 'moment'
import { withStyles } from '@material-ui/core/styles'
import ThreadAvatar from './thread-avatar'

const styles = () => ({
  wrapper: {
    display: 'flex',
    marginBottom: 1,
    padding: '9px 8px 12px 0',
    color: '#605e5c',
    fontSize: 14,
    backgroundColor: 'white',
    cursor: 'pointer',
    lineHeight: '19px',
    '&.unRead': {
      borderLeft: '4px solid #0078d4'
    },
    '&.selected': {
      backgroundColor: '#cfe0f4',
    },
    '&:hover': {
      backgroundColor: '#edebe9',
    }
  },
  avatarWrapper: {
    padding: '6px 12px 0 8px',
  },
  username: {
    color: '#201f1e',
    '&.unRead': {
      fontWeight: 600,
    }
  },
  titleWrapper: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
  },
  title: {
    flex: 1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 130,
    '&.unRead': {
      color: '#0078d4',
      fontWeight: 600,
    }
  }
})

const ThreadCard = ({ classes, thread, isSelected, onClick }) =>  {
  function getContent() {
    const messages = orderBy(thread.messages, 'date', 'desc')
    const firstMessage = head(messages)

    return get(firstMessage, 'content', '')
  }

  function getDate() {
    const { date } = thread
    const momentDate = moment(parseInt(date, 10))
    let format

    if (momentDate.isSame(moment(), 'day')) {
      format = 'h:mm A'
    } else if (momentDate.isSame(moment(), 'week')) {
      format = 'ddd h:mm A'
    } else if (momentDate.isSame(moment(), 'month')) {
      format = 'ddd MM/DD'
    } else {
      format = 'YYYY/MM/DD'
    }

    return momentDate.format(format)
  }

  return (
    <div
      className={classNames(classes.wrapper, {
        selected: isSelected,
      })}
      onClick={onClick}
    >
      <div className={classes.avatarWrapper}>
        <ThreadAvatar username={thread.owner} />
      </div>
      <div style={{ flex: 1 }}>
        <div className={classes.owner}>
          {thread.owner}
        </div>
        <div className={classes.titleWrapper}>
          <span className={classes.title}>
            {thread.title}
          </span>
          <span>{getDate()}</span>
        </div>
        <div>{getContent()}</div>
      </div>
    </div>
  )
}

ThreadCard.propTypes = {
  classes: PropTypes.object.isRequired,
  isSelected: PropTypes.bool,
  thread: PropTypes.object.isRequired,
  onClick: PropTypes.func.isRequired,
}

export default withStyles(styles)(ThreadCard)
