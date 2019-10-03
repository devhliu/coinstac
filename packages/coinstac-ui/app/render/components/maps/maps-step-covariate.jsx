import React, { Component } from 'react';
import ReactDOM from 'react-dom';
import PropTypes from 'prop-types';
import Icon from '@material-ui/core/Icon';
import Paper from '@material-ui/core/Paper';
import Typography from '@material-ui/core/Typography';
import List from '@material-ui/core/List';
import ListItem from '@material-ui/core/ListItem';
import ListItemText from '@material-ui/core/ListItemText';
import { withStyles } from '@material-ui/core/styles';
import FileCopyIcon from '@material-ui/icons/FileCopy';
import DeleteRoundedIcon from '@material-ui/icons/DeleteRounded';
import classNames from 'classnames';

const styles = theme => ({
  rootPaper: {
    ...theme.mixins.gutters(),
    paddingTop: theme.spacing.unit * 1.5,
    paddingBottom: theme.spacing.unit * 1.5,
    marginTop: theme.spacing.unit * 1.5,
    height: '100%',
    overflow: 'scroll',
  },
  title: {
    marginBottom: theme.spacing.unit * 1.5,
  },
  nestedListItem: {
    paddingLeft: theme.spacing.unit * 3,
  },
  listDropzoneContainer: {
    display: 'flex',
  },
  interestList: {
    width: '50%',
    flex: '0 0 auto',
    marginRight: theme.spacing.unit,
  },
  dropZone: {
    flex: '1 0 auto',
  },
  timesIcon: {
    color: '#f05a29 !important',
    fontSize: '1.25rem',
    position: 'absolute',
    top: '-0.75rem',
    right: '-0.75rem',
    background: 'white',
    borderRadius: '50%',
    border: '2px solid white',
    width: '1.5rem',
    height: '1.5rem',
  },
});

class MapsStepCovariate extends Component {
  componentDidUpdate() {
    if (this.refs.Container) {
      let Container = ReactDOM.findDOMNode(this.refs.Container);
      this.props.getContainers(Container);
    }
  }

  render() {
    const {
      step,
      type,
      classes,
      column,
      index,
    } = this.props;

    let name = step.name;

    return (
      <Paper
        className={classNames('drop-panel', classes.rootPaper)}
        elevation={1}
      >
        <Typography style={{fontWeight: '500', fontSize: '1rem'}} className={classes.title}>
          {name}
        </Typography>
        <div className={classes.listDropzoneContainer}>
          <div className={classNames('drop-zone', classes.dropZone)}>
            {
              !column
                ? <div
                    ref="Container"
                    className={`acceptor acceptor-${name}`}
                    data-type={type}
                    data-name={name}
                    data-index={index}
                  />
              : <div className="card-draggable">
                <FileCopyIcon /> {column}
                <span onClick={()=>{this.props.removeMapStep(type, index, column)}}>
                  <Icon
                    className={classNames('fa fa-times-circle', classes.timesIcon)} />
                </span>
                </div>}
          </div>
        </div>
      </Paper>
    );
  }
}

MapsStepCovariate.propTypes = {
  step: PropTypes.object.isRequired,
  classes: PropTypes.object.isRequired,
  type: PropTypes.string.isRequired,
  index: PropTypes.number.isRequired,
  updateConsortiumClientProps: PropTypes.func.isRequired,
};

export default withStyles(styles)(MapsStepCovariate);
