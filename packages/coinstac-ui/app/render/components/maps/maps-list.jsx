import React, { Component } from 'react';
import { connect } from 'react-redux';
import PropTypes from 'prop-types';
import Typography from '@material-ui/core/Typography';
import Grid from '@material-ui/core/Grid';
import { withStyles } from '@material-ui/core';
import ListItem from '../common/list-item';
import { deleteDataMapping } from '../../state/ducks/maps';

const styles = theme => ({
  contentContainer: {
    marginTop: theme.spacing.unit,
    marginBottom: theme.spacing.unit,
  },
  labelInline: {
    fontWeight: 'bold',
    marginRight: theme.spacing.unit,
    display: 'inline-block',
  },
  value: {
    display: 'inline-block',
  },
});

function isMember(userId, groupArr) {
  if (userId && groupArr) {
    return groupArr.indexOf(userId) !== -1;
  }
}

class MapsList extends Component {
  deleteDataMapping = consortiumId => () => {
    const { deleteDataMapping, consortia } = this.props;

    const consortium = consortia.find(c => c.id === consortiumId);

    deleteDataMapping(consortium.id, consortium.activePipelineId);
  }

  getMapItem = (consortium) => {
    const { auth, pipelines, classes } = this.props;

    const pipeline = pipelines.find(pipeline => pipeline.id === consortium.activePipelineId);

    if (!pipeline || !isMember(auth.user.id, consortium.members)) {
      return null;
    }

    const isDataMapped = this.isDataMappedToConsortium(consortium);

    const itemOptions = {
      text: [],
      status: [],
    };

    itemOptions.text.push((
      <div key={`${consortium.id}-active-pipeline-text`} className={classes.contentContainer}>
        <Typography className={classes.labelInline}>
          Active Pipeline:
        </Typography>
        <Typography className={classes.value}>{ pipeline.name }</Typography>
      </div>
    ));

    itemOptions.status.push((
      <span
        key={`${consortium.id}-map-status`}
        className={isDataMapped ? 'mapped true' : 'mapped false'}
      />
    ));

    return (
      <Grid item sm={6} lg={4} key={`${consortium.id}-list-item`}>
        <ListItem
          itemObject={consortium}
          itemOptions={itemOptions}
          itemRoute="/dashboard/maps"
          linkButtonText={isDataMapped ? 'View Details' : 'Map Data to Consortium'}
          linkButtonColor={isDataMapped ? 'primary' : 'secondary'}
          canDelete={isDataMapped}
          deleteItem={this.deleteDataMapping}
          deleteButtonText="Clear Mapping"
        />
      </Grid>
    );
  }

  isDataMappedToConsortium(consortium) {
    const { maps } = this.props;

    return maps.findIndex(m => m.consortiumId === consortium.id) > -1;
  }

  render() {
    const { consortia } = this.props;

    return (
      <div>
        <div className="page-header">
          <Typography variant="h4">
            Maps
          </Typography>
        </div>
        <Grid
          container
          spacing={16}
          direction="row"
          alignItems="stretch"
        >
          {consortia && consortia.map(cons => this.getMapItem(cons))}
        </Grid>
      </div>
    );
  }
}

MapsList.propTypes = {
  maps: PropTypes.array.isRequired,
  auth: PropTypes.object.isRequired,
  consortia: PropTypes.array.isRequired,
  deleteDataMapping: PropTypes.func.isRequired,
  pipelines: PropTypes.array.isRequired,
  classes: PropTypes.object.isRequired,
};

const mapStateToProps = ({ auth, maps }) => {
  return { auth, maps: maps.consortiumDataMappings };
};

export default withStyles(styles)(
  connect(mapStateToProps, {
    deleteDataMapping,
  })(MapsList)
);
